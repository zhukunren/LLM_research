"""Stable presentation names for daily signals, separate from source identities."""
from __future__ import annotations

import hashlib


# Keys are opaque digests; this table never goes to the browser.
_NAMES = {
    '019c01604dc2a6af4f025589a76315d5f2a91005506a19d86af3594bd939f4d4': '雾舟量能策略',
    '0ad1f076ec2786dfa80d353d6f97a9c39e9b56656bf08747f4d54949c00d7ddc': '松弦回调策略',
    '1b54c89731744e08a2bec4972d6408ec1c6e2e3be26cddbbf6ba1f6b4af4d9f9': '栖迟量价策略',
    '25abccf79049ff572aa0a67c708dae6b1aa8c8a3c60e0c72776598caaff0a864': '棠溪顺势策略',
    '58e93b6a715e9ea573b50f3ac4b64ae18ca0ad247f08ee72e3b8f5e28ff41319': '月白蓄势策略',
    '78e3fae7858995bb48ed063f1fa456dbdda1b1bc7c0222267807abcbfbc29031': '砚池领涨策略',
    '831d5b6f52a479110eb579ee172bafea96d1dc670550a3ba1ebbce6d4c7c7967': '知夏双驱策略',
    '8b02d0c8825945e6bdd366e2dcd6ec8502aaec2c94062c5cb4d07e222c05592c': '听澜短线策略',
    '91d162a271ff4c91d25215a60761a7147f327e536f9e49fe983eb3448eb1bc4d': '云岫择时策略',
    '9f3569d532fbacf04e1758ee402e4779f011ec3e34dd8cb0ccba052261891088': '晴川复合策略',
    'a7b66ec04766e9e4a2ebcf57d241ff9612806d304a6173be8d3ef28ed6eb44bc': '青禾逆转策略',
    'b270fafe5176ce01ea4124fe17d9fad609205508a24fa4b84818f562e18b70b6': '星汐修复策略',
    'be1882099033e359ad2ec2c5deca91e9600bf811b9ae847ca699d2084b698226': '竹隐加速策略',
    'c7c416e8add89110071921afabf2be7d0025a97dc3928c8a2ad6564346a6cc36': '疏影动能策略',
    'ff6884cc449e93b88dde47d1d6c17a1db80ac6f887940382c8c8e1e2400f5360': '沐岚承接策略',
}


def strategy_identity(source_name: str) -> tuple[str, str]:
    if not isinstance(source_name, str) or not source_name.strip():
        raise ValueError("Missing strategy identity")
    digest = hashlib.sha256(("daily-signals-v1:" + source_name).encode()).hexdigest()
    first = ("清和", "风荷", "远汀", "雪霁", "林泉", "溪亭", "白榆", "墨林")
    second = ("量化", "优选", "智选", "投研", "研选", "精选", "投资", "资产")
    fallback = first[int(digest[:2], 16) % len(first)] + second[int(digest[2:4], 16) % len(second)] + "策略"
    return "signal-" + digest[:24], _NAMES.get(digest, fallback)
