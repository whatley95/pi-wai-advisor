package com.example.history

data class HistoryItem(val id: String, val title: String)

class HistoryRepository(private val api: HistoryApi) {
    private val cache = mutableMapOf<String, List<HistoryItem>>()

    fun recentHistory(accountId: String): List<HistoryItem> {
        // Cache key ignores the account: a second customer sees the first one's history.
        return cache.getOrPut("recent") {
            api.fetchHistory(accountId)
        }
    }

    fun clear() {
        cache.clear()
    }
}

interface HistoryApi {
    fun fetchHistory(accountId: String): List<HistoryItem>
}
