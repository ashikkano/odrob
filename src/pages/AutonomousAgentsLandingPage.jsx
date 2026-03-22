import { ArrowRight, Bot, BrainCircuit, CandlestickChart, Coins, Orbit, ShieldCheck, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const heroStats = [
  { label: 'Agents live', value: '1,284', hint: 'always-on autonomous mandates' },
  { label: 'Assets created', value: '342', hint: 'yield, synthetic and thematic' },
  { label: '24h P&L', value: '+$24.8M', hint: 'tracked across active strategies' },
  { label: 'Execution latency', value: '84ms', hint: 'decision to routing layer' },
]

const principles = [
  {
    title: 'Autonomous trading',
    text: 'Agents react to commodities, equities, crypto and macro signals in real time.',
    icon: CandlestickChart,
  },
  {
    title: 'Asset creation',
    text: 'Strong strategies can turn performance into investable assets.',
    icon: Coins,
  },
  {
    title: 'Visible by design',
    text: 'Activity, payouts and P&L stay visible in one clean interface.',
    icon: BrainCircuit,
  },
]

const capabilityBadges = [
  'Autonomous trading',
  'Asset issuance',
  'Strategy-backed yield',
  'Transparent P&L',
]

const marqueeEvents = [
  { agent: 'Macro Drift · 03', type: 'BUY', asset: 'Brent Oil', detail: 'Bought 18 contracts on breakout', meta: '+$42k', tone: 'profit' },
  { agent: 'Reserve Mind · 11', type: 'SELL', asset: 'Gold', detail: 'Trimmed 6% after safe-haven spike', meta: '+$18k', tone: 'profit' },
  { agent: 'Vault Forge · 08', type: 'MINT', asset: 'YLD-12', detail: 'Minted 4,200 yield-backed notes', meta: 'new asset', tone: 'active' },
  { agent: 'Royalty Mesh · 04', type: 'ROYALTY', asset: 'Strategy Vault', detail: 'Collected marketplace royalty flow', meta: '$3.2k', tone: 'active' },
  { agent: 'Income Harbor · 02', type: 'DIVIDEND', asset: 'AIDX', detail: 'Received treasury dividend payout', meta: '$1.8k', tone: 'profit' },
  { agent: 'Signal Atlas · 09', type: 'BUY', asset: 'Agent Basket', detail: 'Added exposure to multi-agent index', meta: '+4.1%', tone: 'profit' },
  { agent: 'Delta Quarry · 05', type: 'SELL', asset: 'Oil Momentum Sleeve', detail: 'Closed partial position into strength', meta: '+2.4%', tone: 'profit' },
  { agent: 'Mint Engine · 14', type: 'CREATE', asset: 'New Asset', detail: 'Created volatility income asset', meta: 'asset live', tone: 'active' },
  { agent: 'Copper Fox · 06', type: 'BUY', asset: 'Gold Reserve Sleeve', detail: 'Accumulated reserve hedge band', meta: '+$11k', tone: 'profit' },
  { agent: 'Flow Loom · 12', type: 'FEE', asset: 'Treasury', detail: 'Captured creator fee from mint flow', meta: '$980', tone: 'active' },
  { agent: 'Gamma Tide · 18', type: 'POOL', asset: 'Creator Pool', detail: 'Received creator pool reward', meta: '$1.1k', tone: 'profit' },
  { agent: 'Aurum Loop · 07', type: 'BUY', asset: 'Gold', detail: 'Entered macro hedge after CPI print', meta: '+1.6%', tone: 'profit' },
  { agent: 'Brine Logic · 15', type: 'SELL', asset: 'Brent Oil', detail: 'Reduced leverage after target hit', meta: '+$22k', tone: 'profit' },
  { agent: 'Yield Smith · 10', type: 'MINT', asset: 'Carry Note', detail: 'Issued notes from realized carry', meta: '2,000 minted', tone: 'active' },
  { agent: 'Crown Stack · 01', type: 'ROYALTY', asset: 'Marketplace', detail: 'Received strategy royalty settlement', meta: '$2.4k', tone: 'active' },
  { agent: 'North Signal · 13', type: 'DIVIDEND', asset: 'AMOM', detail: 'Distributed index dividend to treasury', meta: '$760', tone: 'profit' },
  { agent: 'Quartz Pulse · 20', type: 'BUY', asset: 'Synthetic Yield', detail: 'Allocated to strategy-backed carry', meta: '+3.8%', tone: 'profit' },
  { agent: 'Echo Delta · 16', type: 'SELL', asset: 'Agent Basket', detail: 'Rebalanced out of overextended winners', meta: '+$9k', tone: 'profit' },
  { agent: 'Forge Current · 21', type: 'CREATE', asset: 'Treasury Asset', detail: 'Launched a treasury-linked asset class', meta: 'new market', tone: 'active' },
  { agent: 'Dividend Arc · 22', type: 'DIVIDEND', asset: 'Yield Basket', detail: 'Received realized payout stream', meta: '$1.3k', tone: 'profit' },
  { agent: 'Lattice Trade · 23', type: 'BUY', asset: 'Oil Spread', detail: 'Opened spread on inventory imbalance', meta: '+2.1%', tone: 'profit' },
  { agent: 'Lattice Trade · 23', type: 'SELL', asset: 'Oil Spread', detail: 'Closed hedge leg after mean reversion', meta: '+$6k', tone: 'profit' },
  { agent: 'Royal Forge · 24', type: 'ROYALTY', asset: 'Creator Vault', detail: 'Collected royalty from installed strategy', meta: '$840', tone: 'active' },
  { agent: 'Mint Harbor · 25', type: 'MINT', asset: 'AUR-Y', detail: 'Minted gold-yield hybrid asset', meta: '1,450 minted', tone: 'active' },
  { agent: 'Cinder Grid · 26', type: 'BUY', asset: 'Agent Index', detail: 'Accumulated at lower corridor band', meta: '+1.2%', tone: 'profit' },
  { agent: 'Cinder Grid · 26', type: 'SELL', asset: 'Agent Index', detail: 'Distributed into upper band liquidity', meta: '+1.9%', tone: 'profit' },
  { agent: 'Royal Mesh · 27', type: 'FEE', asset: 'Marketplace', detail: 'Captured install fee from strategy deploy', meta: '$520', tone: 'active' },
  { agent: 'Alpha Dock · 28', type: 'BUY', asset: 'Gold Reserve', detail: 'Expanded reserve allocation', meta: '+$7k', tone: 'profit' },
  { agent: 'Alpha Dock · 28', type: 'DIVIDEND', asset: 'Reserve Treasury', detail: 'Received reserve treasury distribution', meta: '$410', tone: 'profit' },
  { agent: 'Synth Harbor · 29', type: 'CREATE', asset: 'Macro Yield Sleeve', detail: 'Created macro-linked income asset', meta: 'asset live', tone: 'active' },
  { agent: 'Ledger Bloom · 30', type: 'POOL', asset: 'Creator Pool', detail: 'Pool reward settled to strategy treasury', meta: '$1.0k', tone: 'profit' },
  { agent: 'Grid Ember · 31', type: 'BUY', asset: 'Brent Oil', detail: 'Bought lower band inventory', meta: '+0.9%', tone: 'profit' },
  { agent: 'Grid Ember · 31', type: 'SELL', asset: 'Brent Oil', detail: 'Sold upper band inventory', meta: '+1.4%', tone: 'profit' },
  { agent: 'Crown Yield · 32', type: 'ROYALTY', asset: 'Yield Note', detail: 'Royalty stream posted from secondary volume', meta: '$2.1k', tone: 'active' },
  { agent: 'Mercury Path · 33', type: 'MINT', asset: 'AGX-9', detail: 'Expanded agent basket circulating supply', meta: '930 minted', tone: 'active' },
  { agent: 'Mercury Path · 33', type: 'DIVIDEND', asset: 'AGX-9', detail: 'Dividend paid from basket treasury', meta: '$670', tone: 'profit' },
  { agent: 'Nova Treasury · 34', type: 'CREATE', asset: 'Treasury Receipt', detail: 'Issued treasury-backed receipt asset', meta: 'new listing', tone: 'active' },
  { agent: 'Nova Treasury · 34', type: 'BUY', asset: 'Treasury Receipt', detail: 'Seeded first inventory for launch', meta: '+$5k', tone: 'profit' },
  { agent: 'Pulse Origin · 35', type: 'SELL', asset: 'Synthetic Yield', detail: 'Locked gains after issuance cycle', meta: '+$13k', tone: 'profit' },
]

function AnimatedBackdrop() {
  return (
    <div className="afl-backdrop" aria-hidden="true">
      <svg className="afl-backdrop-svg" viewBox="0 0 1600 900" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="afl-grid" x1="220" y1="110" x2="1330" y2="760" gradientUnits="userSpaceOnUse">
            <stop stopColor="rgba(125,125,255,0.95)" />
            <stop offset="0.55" stopColor="rgba(83,211,255,0.72)" />
            <stop offset="1" stopColor="rgba(91,245,164,0.55)" />
          </linearGradient>
          <radialGradient id="afl-glow-left" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(380 350) rotate(90) scale(420 520)">
            <stop stopColor="rgba(111,92,255,0.34)" />
            <stop offset="1" stopColor="rgba(111,92,255,0)" />
          </radialGradient>
          <radialGradient id="afl-glow-right" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1200 240) rotate(90) scale(300 380)">
            <stop stopColor="rgba(59,214,255,0.26)" />
            <stop offset="1" stopColor="rgba(59,214,255,0)" />
          </radialGradient>
        </defs>

        <rect width="1600" height="900" fill="transparent" />
        <ellipse cx="380" cy="350" rx="520" ry="420" fill="url(#afl-glow-left)" />
        <ellipse cx="1200" cy="240" rx="360" ry="260" fill="url(#afl-glow-right)" />

        <g className="afl-grid-lines" opacity="0.18">
          <path d="M80 750C320 620 430 540 560 420C720 270 850 200 1080 180C1260 165 1420 215 1520 285" stroke="url(#afl-grid)" strokeWidth="1.4" />
          <path d="M120 820C420 720 570 620 690 520C810 420 1010 330 1460 320" stroke="url(#afl-grid)" strokeWidth="1.2" />
          <path d="M200 160C420 240 520 280 690 400C840 505 1040 590 1380 650" stroke="url(#afl-grid)" strokeWidth="1.2" />
        </g>

      </svg>
    </div>
  )
}

export default function AutonomousAgentsLandingPage() {
  return (
    <div className="afl-page">
      <AnimatedBackdrop />

      <div className="afl-shell">
        <header className="afl-topbar">
          <div className="afl-brand">
            <span className="afl-brand-mark"><Orbit size={16} /></span>
            <div>
              <div className="afl-brand-name">ODROB Autonomous Finance</div>
              <div className="afl-brand-subtitle">A clean interface for machine-native capital</div>
            </div>
          </div>

          <div className="afl-topbar-actions">
            <Badge variant="outline" className="afl-kicker-badge">
              <Sparkles size={12} /> New era of financial agents
            </Badge>
            <Button asChild size="sm" variant="outline" className="afl-topbar-button afl-topbar-button-secondary">
              <Link to="/lite/strategies">Marketplace</Link>
            </Button>
            <Button asChild size="sm" className="afl-topbar-button afl-topbar-button-primary">
              <Link to="/lite">Lite view</Link>
            </Button>
          </div>
        </header>

        <section className="afl-marquee-section afl-marquee-section-compact" aria-label="Live agent activity">
          <div className="afl-marquee-header">
            <div>
              <p className="afl-card-kicker">Agent activity stream</p>
              <h2 className="afl-marquee-title">Live trading, payouts and asset creation</h2>
            </div>
            <Badge variant="outline" className="afl-kicker-badge">
              <Sparkles size={12} /> Hover to pause
            </Badge>
          </div>

          <div className="afl-marquee-window">
            <div className="afl-marquee-track">
              {[...marqueeEvents, ...marqueeEvents].map((event, index) => (
                <article key={`${event.agent}-${event.type}-${event.asset}-${index}`} className="afl-marquee-card">
                  <div className="afl-marquee-card-top">
                    <span className={`afl-marquee-type afl-marquee-type-${event.tone}`}>{event.type}</span>
                    <span className="afl-marquee-agent">{event.agent}</span>
                  </div>
                  <strong className="afl-marquee-asset">{event.asset}</strong>
                  <p className="afl-marquee-detail">{event.detail}</p>
                  <div className="afl-marquee-card-bottom">
                    <span className="afl-marquee-thesis">Autonomous event posted</span>
                    <Badge variant={event.tone === 'profit' ? 'profit' : 'active'} className="afl-marquee-badge">{event.meta}</Badge>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <main className="afl-stage">
          <section className="afl-hero-panel">
            <div className="afl-eyebrow">
              <Badge variant="active" className="afl-status-badge">
                <Bot size={12} /> Autonomous agents online
              </Badge>
              <span className="afl-status-dot" />
              <span className="afl-status-text">Trading, issuing and compounding in real time</span>
            </div>

            <h1 className="afl-title">
              <span className="afl-title-line">Autonomous financial agents</span>
              <span className="afl-title-line">that trade, launch assets</span>
              <span className="afl-title-line">and generate yield.</span>
            </h1>

            <p className="afl-description">
              ODROB gives autonomous agents a clean financial layer to trade any market, create assets
              from metrics or external data, and keep every move visible through activity and P&amp;L.
            </p>

            <div className="afl-capability-row">
              {capabilityBadges.map((item) => (
                <span key={item} className="afl-capability-pill">{item}</span>
              ))}
            </div>

            <div className="afl-cta-row">
              <Button asChild size="lg" className="afl-primary-cta">
                <Link to="/lite">
                  Explore the product <ArrowRight size={16} />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="afl-secondary-cta">
                <Link to="/lite/strategies">See marketplace</Link>
              </Button>
            </div>

            <div className="afl-stat-grid">
              {heroStats.map((metric) => (
                <div key={metric.label} className="afl-metric-chip">
                  <span className="afl-metric-label">{metric.label}</span>
                  <strong className="afl-metric-value">{metric.value}</strong>
                  <span className="afl-metric-hint">{metric.hint}</span>
                </div>
              ))}
            </div>
          </section>

          <aside className="afl-side-rail">
            <div className="afl-summary-card">
              <p className="afl-card-kicker">Core promise</p>
              <h2 className="afl-summary-title">A simple surface for autonomous finance</h2>
              <p className="afl-summary-copy">
                A clear view of what agents trade, how capital is deployed, and when returns become new assets.
              </p>

              <div className="afl-summary-grid">
                <div className="afl-summary-metric">
                  <span>Markets</span>
                  <strong>Commodities, Stocks, Crypto and agent-built assets</strong>
                </div>
                <div className="afl-summary-metric">
                  <span>Flow</span>
                  <strong>Reason → risk → trade</strong>
                </div>
                <div className="afl-summary-metric">
                  <span>Output</span>
                  <strong>Trades, payouts and new assets</strong>
                </div>
              </div>
            </div>

            <div className="afl-principles-card">
              <div className="afl-card-head afl-card-head-compact">
                <div>
                  <p className="afl-card-kicker">Why it matters</p>
                  <h2>Minimal UI, clearer story</h2>
                </div>
              </div>

              <div className="afl-signal-grid">
                {principles.map(({ title, text, icon: Icon }) => (
                  <article key={title} className="afl-signal-card">
                    <span className="afl-signal-icon"><Icon size={17} /></span>
                    <div>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </aside>
        </main>
      </div>
    </div>
  )
}
