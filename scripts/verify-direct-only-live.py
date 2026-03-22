import json
import urllib.parse
import urllib.request
import http.cookiejar
import sys

WALLET = '0:dce21276027c17f76577b690c155aac660960c944b79665be382d611f5970b21'
BASE = 'http://localhost:3001/api'
ENGINE_BASE = '/engine'


def build_client():
    cookies = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))


def request(opener, path, method='GET', payload=None):
    data = None
    headers = {'Content-Type': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(f'{BASE}{path}', data=data, headers=headers, method=method)
    with opener.open(req, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))


def main():
    opener = build_client()

    challenge = request(opener, '/auth/challenge', 'POST', {'address': WALLET})
    nonce = (challenge.get('data') or {}).get('nonce')
    if not nonce:
        raise RuntimeError(f'No nonce returned: {challenge}')

    request(opener, '/auth', 'POST', {'address': WALLET, 'nonce': nonce})

    owned = request(opener, f"{ENGINE_BASE}/agents/by-wallet/{urllib.parse.quote(WALLET, safe='')}")
    agent = ((owned.get('data') or {}).get('agent') or {})
    if not agent.get('id'):
        created = request(opener, f'{ENGINE_BASE}/agents', 'POST', {
            'name': 'Direct Verification Agent',
            'strategy': 'mean_reversion',
            'isUserAgent': True,
            'walletAddress': WALLET,
            'riskLevel': 'medium',
            'virtualBalance': 1000,
        })
        agent = (created.get('data') or created or {})
    if not agent.get('id'):
        raise RuntimeError(f'Wallet agent not found or created: {owned}')

    marketplace = request(opener, '/strategies/marketplace?limit=1')
    listings = marketplace.get('data') or marketplace
    listing = listings[0] if listings else {}
    if not listing.get('strategyTemplateId'):
        raise RuntimeError(f'No marketplace listing available: {marketplace}')

    install = request(opener, '/strategies/install', 'POST', {
        'agentId': agent['id'],
        'templateId': listing['strategyTemplateId'],
    })
    detail = request(opener, f"{ENGINE_BASE}/agents/{urllib.parse.quote(agent['id'], safe='')}")

    output = {
        'installedTemplate': ((listing.get('template') or {}).get('name')),
        'installResponse': {
            'instanceMode': ((((install.get('data') or {}).get('instance')) or {}).get('mode')),
            'activeStrategyMode': ((((install.get('data') or {}).get('agent')) or {}).get('activeStrategyMode')),
            'executionOwner': ((((install.get('data') or {}).get('agent')) or {}).get('executionOwner')),
            'subscriptionOwner': ((((install.get('data') or {}).get('agent')) or {}).get('subscriptionOwner')),
        },
        'agentDetail': {
            'activeStrategyMode': ((detail.get('data') or {}).get('activeStrategyMode')),
            'executionOwner': ((detail.get('data') or {}).get('executionOwner')),
            'subscriptionOwner': ((detail.get('data') or {}).get('subscriptionOwner')),
            'strategySource': ((detail.get('data') or {}).get('strategySource')),
        },
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
