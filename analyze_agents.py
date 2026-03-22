#!/usr/bin/env python3
"""Analyze agent trading performance by strategy"""
import json, urllib.request

def api(path):
    with urllib.request.urlopen(f'http://localhost:3001{path}') as r:
        return json.loads(r.read())

agents = api('/api/engine/agents')
metrics = api('/api/engine/metrics')
indexes = api('/api/indexes')

# ─── Overall metrics ───
print("=" * 90)
print("📊 ENGINE OVERVIEW")
print("=" * 90)
print(f"  🤖 Agents: {metrics['totalAgents']}  |  💹 Trades: {metrics['totalTrades']}  |  📊 Volume: ${metrics['totalVolume']:,.0f}")
print(f"  💰 Total Equity: ${metrics['totalEquity']:,.0f}  |  Initial: ${metrics['totalInitial']:,.0f}")
print(f"  📈 Total PnL: ${metrics['totalPnl']:,.2f} ({metrics['totalPnlPercent']:.2f}%)")
print(f"  🏆 Win Rate: {metrics['winRate']*100:.1f}%  |  Sharpe: {metrics['sharpeRatio']}  |  Max DD: {metrics['maxDrawdown']}%")
print(f"  ⏱  Uptime: {metrics['uptime']/1000:.0f}s  |  Ticks: {metrics['tickCount']}")

# ─── Per-strategy breakdown ───
strats = {}
for a in agents:
    s = a.get('strategy', '?')
    if s not in strats:
        strats[s] = []
    init = a.get('initialBalance', 1000)
    bal = a.get('virtualBalance', 0)
    pnl = bal - init
    pnl_pct = (pnl / init) * 100 if init > 0 else 0
    trades = a.get('totalTrades', 0)
    wins = a.get('winningTrades', 0)
    losses = a.get('losingTrades', 0)
    wr = (wins / trades * 100) if trades > 0 else 0
    
    strats[s].append({
        'name': a['name'], 'bal': bal, 'init': init,
        'pnl': pnl, 'pnl_pct': pnl_pct,
        'trades': trades, 'wins': wins, 'losses': losses, 'wr': wr,
        'equity': a.get('equity', bal),
    })

print()
print("=" * 90)
print("📋 PERFORMANCE BY STRATEGY")
print("=" * 90)
header = f"{'Strategy':<18} {'#':>3} {'AvgPnL%':>9} {'AvgTrades':>10} {'AvgWR%':>7} {'BestPnL%':>10} {'WorstPnL%':>11} {'TotalPnL$':>10}"
print(header)
print("─" * 90)

strat_rows = []
for s in sorted(strats.keys()):
    arr = strats[s]
    n = len(arr)
    avg_pnl = sum(x['pnl_pct'] for x in arr) / n
    avg_tr = sum(x['trades'] for x in arr) / n
    avg_wr = sum(x['wr'] for x in arr) / n
    best = max(x['pnl_pct'] for x in arr)
    worst = min(x['pnl_pct'] for x in arr)
    total = sum(x['pnl'] for x in arr)
    strat_rows.append((s, n, avg_pnl, avg_tr, avg_wr, best, worst, total))
    print(f"{s:<18} {n:>3} {avg_pnl:>+8.2f}% {avg_tr:>9.0f} {avg_wr:>6.1f}% {best:>+9.2f}% {worst:>+10.2f}% {total:>+9.0f}$")

# ─── Top & Bottom agents ───
all_sorted = sorted(
    [{'name': a['name'], 'strategy': a.get('strategy','?'), 
      'pnl': a.get('virtualBalance',0) - a.get('initialBalance',1000),
      'pnl_pct': ((a.get('virtualBalance',0) - a.get('initialBalance',1000)) / a.get('initialBalance',1000)) * 100,
      'trades': a.get('totalTrades',0),
      'wr': (a.get('winningTrades',0) / max(1, a.get('totalTrades',0))) * 100,
      'init': a.get('initialBalance',1000),
      'bal': a.get('virtualBalance',0),
    } for a in agents],
    key=lambda x: x['pnl_pct'], reverse=True
)

print()
print("=" * 90)
print("🏆 TOP 15 AGENTS (by PnL%)")
print("=" * 90)
print(f"{'#':>3} {'Name':<22} {'Strategy':<16} {'Init$':>7} {'Balance$':>9} {'PnL$':>8} {'PnL%':>8} {'Trades':>7} {'WR%':>6}")
print("─" * 90)
for i, a in enumerate(all_sorted[:15], 1):
    print(f"{i:>3} {a['name']:<22} {a['strategy']:<16} {a['init']:>6.0f} {a['bal']:>8.0f} {a['pnl']:>+7.0f} {a['pnl_pct']:>+7.2f}% {a['trades']:>6} {a['wr']:>5.1f}%")

print()
print("=" * 90)
print("💀 BOTTOM 15 AGENTS (by PnL%)")
print("=" * 90)
print(f"{'#':>3} {'Name':<22} {'Strategy':<16} {'Init$':>7} {'Balance$':>9} {'PnL$':>8} {'PnL%':>8} {'Trades':>7} {'WR%':>6}")
print("─" * 90)
for i, a in enumerate(all_sorted[-15:], 1):
    print(f"{i:>3} {a['name']:<22} {a['strategy']:<16} {a['init']:>6.0f} {a['bal']:>8.0f} {a['pnl']:>+7.0f} {a['pnl_pct']:>+7.2f}% {a['trades']:>6} {a['wr']:>5.1f}%")

# ─── Trade frequency analysis ───
print()
print("=" * 90)
print("⚡ TRADE FREQUENCY ANALYSIS")
print("=" * 90)
zero_trades = [a for a in agents if a.get('totalTrades',0) == 0]
few_trades = [a for a in agents if 0 < a.get('totalTrades',0) < 10]
active = [a for a in agents if a.get('totalTrades',0) >= 10]
heavy = [a for a in agents if a.get('totalTrades',0) >= 100]

print(f"  0 trades:    {len(zero_trades)} agents (idle)")
print(f"  1-9 trades:  {len(few_trades)} agents (barely active)")
print(f"  10+ trades:  {len(active)} agents (active)")
print(f"  100+ trades: {len(heavy)} agents (heavy traders)")

# Distribution of trades
trade_counts = sorted([a.get('totalTrades',0) for a in agents])
print(f"  Min: {trade_counts[0]}  Median: {trade_counts[len(trade_counts)//2]}  Max: {trade_counts[-1]}")
print(f"  Avg: {sum(trade_counts)/len(trade_counts):.0f} trades/agent")

# ─── PnL distribution ───
print()
print("=" * 90)
print("💰 PnL DISTRIBUTION")
print("=" * 90)
pnls = [a.get('virtualBalance',0) - a.get('initialBalance',1000) for a in agents]
profitable = [p for p in pnls if p > 0]
losing = [p for p in pnls if p < 0]
flat = [p for p in pnls if p == 0]
print(f"  Profitable: {len(profitable)} agents (avg +${sum(profitable)/max(1,len(profitable)):.0f})")
print(f"  Losing:     {len(losing)} agents (avg -${abs(sum(losing)/max(1,len(losing))):.0f})")
print(f"  Flat:       {len(flat)} agents")
print(f"  Total PnL:  ${sum(pnls):,.2f}")

# ─── Per-index holdings analysis ───
print()
print("=" * 90)
print("📊 INDEX PERFORMANCE")
print("=" * 90)
for idx in indexes:
    sym = idx.get('symbol','?')
    fid = idx.get('formulaId','?')
    price = idx.get('oraclePrice', 0)
    vol = idx.get('totalVolume', 0)
    holders = idx.get('holderCount', 0)
    ret = ((price - 1) * 100) if price else 0
    supply = idx.get('totalSupply', 0)
    trades = idx.get('tradeCount', 0)
    print(f"  {sym:<8} {fid:<22} Price=${price:.4f} ({ret:+.1f}%)  Vol=${vol:,.0f}  Holders={holders}  Supply={supply:.0f}  Trades={trades}")

# ─── Key insights ───
print()
print("=" * 90)
print("🔍 KEY INSIGHTS & BOTTLENECKS")
print("=" * 90)

# Check avg PnL per trade
avg_pnl_per_trade = metrics['totalPnl'] / max(1, metrics['totalTrades'])
print(f"  💵 Avg PnL per trade: ${avg_pnl_per_trade:.4f}")
print(f"  📊 Avg volume per trade: ${metrics['totalVolume'] / max(1, metrics['totalTrades']):.2f}")

# Check agent config issues
seed_agents = [a for a in agents if not a['name'].startswith('W')]
wave_agents = [a for a in agents if a['name'].startswith('W')]

seed_pnl = sum(a.get('virtualBalance',0) - a.get('initialBalance',1000) for a in seed_agents)
wave_pnl = sum(a.get('virtualBalance',0) - a.get('initialBalance',1000) for a in wave_agents)
seed_trades = sum(a.get('totalTrades',0) for a in seed_agents)
wave_trades = sum(a.get('totalTrades',0) for a in wave_agents)

print(f"  🏛  Seed agents ({len(seed_agents)}):  PnL=${seed_pnl:+,.0f}  Trades={seed_trades}  AvgTr={seed_trades/max(1,len(seed_agents)):.0f}")
print(f"  🌊 Wave agents ({len(wave_agents)}): PnL=${wave_pnl:+,.0f}  Trades={wave_trades}  AvgTr={wave_trades/max(1,len(wave_agents)):.0f}")

# Check if many agents have same low balance (fees eating profits)
fee_impact = metrics['totalVolume'] * 0.003  # 0.3% trading fee
print(f"  🏦 Estimated total trading fees: ${fee_impact:,.0f} (0.3% × volume)")
print(f"  📉 Fee impact vs PnL: fees = {fee_impact/max(1,abs(metrics['totalPnl']))*100:.0f}% of total PnL")

# Check spread / market maker impact
mm_agents = [a for a in agents if a.get('strategy') == 'market_maker']
if mm_agents:
    mm_pnl = sum(a.get('virtualBalance',0) - a.get('initialBalance',1000) for a in mm_agents)
    mm_trades = sum(a.get('totalTrades',0) for a in mm_agents)
    print(f"  🏪 Market makers ({len(mm_agents)}): PnL=${mm_pnl:+,.0f}  Trades={mm_trades}")
    
print()
