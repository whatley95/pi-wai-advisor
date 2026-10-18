package com.example.history

class HistoryScreen(private val viewModel: HistoryViewModel) {
    fun onShow() {
        viewModel.load()
    }
}
