from app.errors import OrderNotFound


def get_order(repo, order_id):
    try:
        return repo.find(order_id)
    except KeyError:
        raise OrderNotFound(order_id)
    except Exception:
        return None  # swallows database errors as "not found"
