import os.path
from db import connect
from .models import User

try:
    from cache import get_cache
except ImportError:
    get_cache = None


def main():
    conn = connect()
    return User(conn)


class App:
    pass
