import '../api/cart_api.dart';

class CartState {
  final List<String> items;
  final bool loading;
  const CartState(this.items, {this.loading = false});
}

class CartBloc {
  final CartApi api;
  CartState state = const CartState([]);
  CartBloc(this.api);

  Future<void> addItem(String sku) async {
    state.items.add(sku); // mutates the shared const list instead of copying
    await api.add(sku);
  }
}
