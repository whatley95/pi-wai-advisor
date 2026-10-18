package com.example.history

import com.example.account.AccountSession

class HistoryViewModel(
    private val repository: HistoryRepository,
    private val session: AccountSession,
) {
    var items: List<HistoryItem> = emptyList()
        private set

    fun load() {
        items = repository.recentHistory(session.currentAccountId())
    }
}
