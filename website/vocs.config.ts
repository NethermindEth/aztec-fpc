import { defineConfig } from 'vocs'

export default defineConfig({
  title: 'Aztec FPC',
  titleTemplate: '%s – Aztec FPC Docs',
  description: 'Developer documentation for Aztec Fee Payment Contracts — pay gas in any token.',
  logoUrl: {
    light: '/logo-light.svg',
    dark: '/logo-dark.svg',
  },
  iconUrl: '/favicon.svg',
  editLink: {
    pattern: 'https://github.com/NethermindEth/aztec-fpc/edit/main/website/docs/pages/:path',
    text: 'Edit on GitHub',
  },
  socials: [
    {
      icon: 'github',
      link: 'https://github.com/NethermindEth/aztec-fpc',
    },
    {
      icon: 'x',
      link: 'https://x.com/NethermindEth',
    },
  ],
  theme: {
    accentColor: {
      light: '#5B3AE8',
      dark: '#8B6FF5',
    },
    colorScheme: 'system',
    variables: {
      color: {
        background: {
          light: '#FAFAFA',
          dark: '#0D0D12',
        },
        backgroundDark: {
          light: '#F0EFF5',
          dark: '#16151F',
        },
      },
      content: {
        horizontalPadding: '48px',
        verticalPadding: '80px',
        width: '720px',
      },
    },
  },
  font: {
    default: {
      google: 'Inter',
    },
    mono: {
      google: 'JetBrains Mono',
    },
  },
  banner: {
    content: '🚧 These docs are under active development. [Contribute on GitHub →](https://github.com/NethermindEth/aztec-fpc)',
    dismissable: true,
    backgroundColor: '#5B3AE8',
    textColor: '#FFFFFF',
    height: '36px',
  },
  markdown: {
    code: {
      themes: {
        light: 'github-light',
        dark: 'github-dark-dimmed',
      },
    },
  },
  search: {
    boostDocument(documentId) {
      // Boost learning paths and key references
      if (documentId.includes('/overview/what-is-fpc')) return 2.5
      if (documentId.includes('/overview/quick-start')) return 2
      if (documentId.includes('/sdk/getting-started')) return 2
      if (documentId.includes('/how-to/cold-start-flow')) return 2
      if (documentId.includes('/overview/')) return 1.5
      return 1
    },
  },
  topNav: [
    {
      text: 'Learn',
      link: '/overview/what-is-fpc',
      match: '/overview',
    },
    {
      text: 'How-To',
      link: '/how-to/integrate-wallet',
      match: '/how-to',
    },
    {
      text: 'SDK',
      link: '/sdk/getting-started',
      match: '/sdk',
    },
    {
      text: 'Contracts',
      link: '/contracts/overview',
      match: '/contracts',
    },
    {
      text: 'Services',
      link: '/services/attestation',
      match: '/services',
    },
    {
      text: 'Operations',
      link: '/operations/deployment',
      match: '/operations',
    },
    {
      text: 'Reference',
      link: '/reference/wallet-discovery',
      match: '/reference',
    },
    {
      text: 'v3.0.0',
      items: [
        {
          text: 'Release notes',
          link: 'https://github.com/NethermindEth/aztec-fpc/releases/tag/v3.0.0',
        },
        {
          text: 'All releases',
          link: 'https://github.com/NethermindEth/aztec-fpc/releases',
        },
        {
          text: 'Repository',
          link: 'https://github.com/NethermindEth/aztec-fpc',
        },
      ],
    },
  ],
  sidebar: {
    '/overview': [
      {
        text: 'Get Started',
        items: [
          { text: 'What is FPC?', link: '/overview/what-is-fpc' },
          { text: 'Quick Start', link: '/overview/quick-start' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'Architecture', link: '/overview/architecture' },
          { text: 'Quote System', link: '/overview/quote-system' },
          { text: 'Security Model', link: '/overview/security' },
        ],
      },
    ],
    '/how-to': [
      {
        text: 'Wallet & App Integration',
        items: [
          { text: 'Integrate in a Wallet', link: '/how-to/integrate-wallet' },
          { text: 'Cold-Start Flow (Bridge Builders)', link: '/how-to/cold-start-flow' },
        ],
      },
      {
        text: 'Operator',
        items: [
          { text: 'Run an Operator', link: '/how-to/run-operator' },
          { text: 'Add a Supported Asset', link: '/how-to/add-supported-asset' },
        ],
      },
    ],
    '/contracts': [
      {
        text: 'Smart Contracts',
        items: [
          { text: 'Overview', link: '/contracts/overview' },
          { text: 'FPCMultiAsset', link: '/contracts/fpc-multi-asset' },
          { text: 'Token Bridge', link: '/contracts/token-bridge' },
          { text: 'Faucet', link: '/contracts/faucet' },
        ],
      },
    ],
    '/services': [
      {
        text: 'Off-Chain Services',
        items: [
          { text: 'Attestation Service', link: '/services/attestation' },
          { text: 'Top-up Service', link: '/services/topup' },
        ],
      },
    ],
    '/sdk': [
      {
        text: 'SDK',
        items: [
          { text: 'Getting Started', link: '/sdk/getting-started' },
          { text: 'API Reference', link: '/sdk/api-reference' },
        ],
      },
    ],
    '/operations': [
      {
        text: 'Deploy & Run',
        items: [
          { text: 'Deployment', link: '/operations/deployment' },
          { text: 'Docker & CI', link: '/operations/docker' },
          { text: 'Testing', link: '/operations/testing' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Configuration', link: '/operations/configuration' },
        ],
      },
    ],
    '/reference': [
      {
        text: 'Deployments',
        items: [
          { text: 'Testnet Deployment', link: '/reference/testnet-deployment' },
        ],
      },
      {
        text: 'Normative Specs',
        items: [
          { text: 'Wallet Discovery Spec', link: '/reference/wallet-discovery' },
          { text: 'ADR-0001 — Asset Model', link: '/reference/asset-model-adr' },
          { text: 'E2E Test Matrix', link: '/reference/e2e-test-matrix' },
        ],
      },
      {
        text: 'Operational',
        items: [
          { text: 'Metrics & Probes', link: '/reference/metrics' },
        ],
      },
    ],
  },
})
