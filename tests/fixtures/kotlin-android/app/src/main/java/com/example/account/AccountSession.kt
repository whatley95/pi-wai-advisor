package com.example.account

class AccountSession {
    private var accountId: String = ""

    fun currentAccountId(): String = accountId

    fun switchAccount(newAccountId: String) {
        accountId = newAccountId
        // Note: does not notify HistoryRepository to clear its cache.
    }
}
