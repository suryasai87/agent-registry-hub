import pytest
from starlette.requests import Request

from core import config, identity


def request(**headers):
    raw = [(k.replace("_", "-").lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


def test_forwarded_email_wins_and_is_normalised():
    user = identity.current_user(request(x_forwarded_email="  Jane.Doe@Example.com ", x_forwarded_preferred_username="other@example.com", x_forwarded_user="123@456"))
    assert user["email"] == "jane.doe@example.com"
    assert user["name"] == "Jane Doe"
    assert user["user_id"] == "123@456"
    assert user["source"] == "apps"


def test_preferred_username_then_forwarded_user():
    assert identity.current_user(request(x_forwarded_preferred_username="sam_lee@example.com"))["email"] == "sam_lee@example.com"
    user = identity.current_user(request(x_forwarded_user="8812@1444"))
    assert user["email"] == "8812@1444" and user["source"] == "apps"


def test_local_fallback(monkeypatch):
    monkeypatch.setattr(config, "LOCAL_USER", "dev.person@localhost")
    user = identity.current_user(request())
    assert user == {"email": "dev.person@localhost", "name": "Dev Person", "user_id": None, "source": "local", "obo_token": False, "is_admin": False}


def test_obo_token_is_a_presence_flag_only():
    secret = "dapi-very-secret-token"
    user = identity.current_user(request(x_forwarded_email="a@b.com", x_forwarded_access_token=secret))
    assert user["obo_token"] is True
    assert secret not in repr(user)
    assert identity.current_user(request(x_forwarded_email="a@b.com", x_forwarded_access_token="  "))["obo_token"] is False


def test_registry_admins(monkeypatch):
    monkeypatch.setattr(config, "REGISTRY_ADMINS", frozenset({"boss@example.com"}))
    assert identity.current_user(request(x_forwarded_email="Boss@Example.com"))["is_admin"] is True
    assert identity.current_user(request(x_forwarded_email="intern@example.com"))["is_admin"] is False


@pytest.mark.parametrize(("email", "name"), [
    ("jane.doe@x.com", "Jane Doe"),
    ("jane_doe@x.com", "Jane Doe"),
    ("mary-ann.o@x.com", "Mary Ann O"),
    ("solo@x.com", "Solo"),
    ("a1b2c3d4-0000-1111-2222-333344445555", "a1b2c3d4-0000-1111-2222-333344445555"),
])
def test_display_name(email, name):
    assert identity.display_name(email) == name


def test_env_parsing_helpers():
    assert config.ident("registry") == "registry"
    for bad in ("1abc", "a-b", "a;drop", "", "x" * 64):
        with pytest.raises(ValueError):
            config.ident(bad)
    assert config.qualified("audit_log", "registry") == ("registry", "audit_log")
    assert config.qualified("ops.audit_log", "registry") == ("ops", "audit_log")
    with pytest.raises(ValueError):
        config.qualified("a.b.c", "registry")
