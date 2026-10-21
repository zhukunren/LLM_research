import json
import time

from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
import pytest

from apps.api.app import auth


@pytest.fixture
def signed_identity(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())) | {"kid": "fixture", "use": "sig", "alg": "RS256"}
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: {"keys": [jwk]})
    configuration = {"issuer": "https://issuer.example", "client_id": "fixture-client"}
    metadata = {"jwks_uri": "https://issuer.example/keys"}
    claims = {"iss": configuration["issuer"], "aud": configuration["client_id"], "sub": "external-user", "exp": int(time.time())+120, "iat": int(time.time()), "nonce": "expected"}
    return key, claims, configuration, metadata


def test_real_rs256_signature_and_claims(signed_identity):
    key, claims, config, metadata = signed_identity
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fixture"})
    assert auth.verify_id_token(token, "expected", config, metadata)["sub"] == "external-user"


@pytest.mark.parametrize("changes", [
    {"iss": "https://attacker.example"}, {"aud": "other-client"}, {"exp": 1},
    {"iat": 9999999999}, {"nonce": "replayed"}, {"nonce": 123},
    {"sub": 123}, {"azp": "other-client"}, {"aud": ["fixture-client", "other-client"]},
])
def test_invalid_claims_are_rejected(signed_identity, changes):
    key, claims, config, metadata = signed_identity
    token = jwt.encode(claims | changes, key, algorithm="RS256", headers={"kid": "fixture"})
    with pytest.raises((jwt.PyJWTError, ValueError)):
        auth.verify_id_token(token, "expected", config, metadata)


def test_missing_expiry_and_wrong_signature_or_algorithm_are_rejected(signed_identity):
    key, claims, config, metadata = signed_identity
    wrong = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    del claims["exp"]
    tokens = [jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fixture"}),
              jwt.encode(claims, wrong, algorithm="RS256", headers={"kid": "fixture"}),
              jwt.encode(claims, "fixture-secret" * 4, algorithm="HS256", headers={"kid": "fixture"})]
    for token in tokens:
        with pytest.raises((jwt.PyJWTError, ValueError)):
            auth.verify_id_token(token, "expected", config, metadata)
