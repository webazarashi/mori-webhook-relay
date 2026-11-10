// サブリクエスト（外部への fetch）の回数を数えて、上限を超えないようにする
// Webhook の送信とエラー通知のために、reserve 回分を残しておく

export class BudgetExceededError extends Error {
  constructor(message = "サブリクエストの予算を使い切りました") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class SubrequestBudget {
  constructor(fetchImpl, limit, reserve = 3) {
    // Workers ではグローバルの fetch をメソッドとして呼ぶと Illegal invocation になるので、関数に包む
    this.inner = (url, init) => fetchImpl(url, init);
    this.limit = limit;
    this.reserve = reserve;
    this.used = 0;
    /** MCP・トークン用（予備には手を付けない） */
    this.fetch = (url, init) => this.#call(url, init, this.limit - this.reserve);
    /** Webhook・通知用（予備も使える） */
    this.reservedFetch = (url, init) => this.#call(url, init, this.limit);
  }

  /** 予備を残したまま、あと n 回使えるか */
  canSpend(n = 1) {
    return this.used + n <= this.limit - this.reserve;
  }

  #call(url, init, cap) {
    if (this.used >= cap) return Promise.reject(new BudgetExceededError());
    this.used++;
    return this.inner(url, init);
  }
}
