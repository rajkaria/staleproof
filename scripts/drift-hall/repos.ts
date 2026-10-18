/**
 * The Drift Hall corpus: popular, active repositories Staleproof did not choose for its own precision runs (none
 * of them is in .ocean/PRECISION.md), each pinned to the commit the findings were checked at. Written by
 * scripts/drift-hall/resolve.ts (2026-10-18T01:36:25.817Z); stars are the count at that time.
 */
export type DriftLanguage = 'python' | 'typescript' | 'go';

export interface DriftRepo {
  /** owner/name as GitHub spells it. */
  repo: string;
  language: DriftLanguage;
  branch: string;
  /** The commit linted and hand-checked; permalinks point at it. */
  sha: string;
  stars: number;
  /** AI agent files at the repository root at that commit. */
  agentFiles: string[];
}

export const RESOLVED_AT = "2026-10-18T01:36:25.817Z";

export const CORPUS: DriftRepo[] = [
  {
    "repo": "fastapi/typer",
    "language": "python",
    "branch": "master",
    "sha": "a5882dedf0bc7a46cd861fdfca020f88519e0f21",
    "stars": 20119,
    "agentFiles": []
  },
  {
    "repo": "fastapi/fastapi",
    "language": "python",
    "branch": "master",
    "sha": "b23d78f2ce4e7b3ea48a59f51ca249690d9fd02c",
    "stars": 103180,
    "agentFiles": []
  },
  {
    "repo": "fastapi/sqlmodel",
    "language": "python",
    "branch": "main",
    "sha": "462b59d9cd1cc3d9072735435330ef9ab6d15cbf",
    "stars": 18411,
    "agentFiles": []
  },
  {
    "repo": "pallets/click",
    "language": "python",
    "branch": "main",
    "sha": "2247b35ea1c47c727d7a06e51fa280e12a863ff6",
    "stars": 17789,
    "agentFiles": []
  },
  {
    "repo": "psf/requests",
    "language": "python",
    "branch": "main",
    "sha": "611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60",
    "stars": 54476,
    "agentFiles": []
  },
  {
    "repo": "Kludex/starlette",
    "language": "python",
    "branch": "main",
    "sha": "b7901fb908f0c6c3b8b6e495517cea6b2e77e66b",
    "stars": 12673,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "Kludex/uvicorn",
    "language": "python",
    "branch": "main",
    "sha": "07bd5d4c94c093960de94d1c96000fb0fa029f13",
    "stars": 11018,
    "agentFiles": []
  },
  {
    "repo": "Textualize/rich",
    "language": "python",
    "branch": "main",
    "sha": "9d8f9a372cc5916fd4781fec207ced7ddac2f08f",
    "stars": 57558,
    "agentFiles": []
  },
  {
    "repo": "Textualize/textual",
    "language": "python",
    "branch": "main",
    "sha": "5e5b7ef58b8c5572c13a3ff9027d756623661495",
    "stars": 37475,
    "agentFiles": []
  },
  {
    "repo": "huggingface/smolagents",
    "language": "python",
    "branch": "main",
    "sha": "96f33faaf028479119ec8d34507b47694cf14e34",
    "stars": 29899,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "huggingface/huggingface_hub",
    "language": "python",
    "branch": "main",
    "sha": "bb2ef7579c3d2dc2eb49b16ccf15a070fe5b7023",
    "stars": 3989,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "langchain-ai/langchain",
    "language": "python",
    "branch": "master",
    "sha": "bd5b134d876ef47858beef27bd29c81eeda03293",
    "stars": 148002,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "langchain-ai/langgraph",
    "language": "python",
    "branch": "main",
    "sha": "0870f5efcec9d486046ae8abce0735aa7d1f3b79",
    "stars": 43422,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "openai/openai-python",
    "language": "python",
    "branch": "main",
    "sha": "547ecb1e4fc233f19030736c29fee4374dfbaca1",
    "stars": 31870,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "openai/openai-agents-python",
    "language": "python",
    "branch": "main",
    "sha": "9abc9182d06dbd28330af888306031269d57a175",
    "stars": 30104,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "anthropics/claude-agent-sdk-python",
    "language": "python",
    "branch": "main",
    "sha": "f93e29cc951cd5fddcaaed9f3c49c3c38dedd6ab",
    "stars": 8293,
    "agentFiles": [
      ".claude",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "crewAIInc/crewAI",
    "language": "python",
    "branch": "main",
    "sha": "40bb2d3b586e8367d206090cc62df5242206008f",
    "stars": 59807,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "marimo-team/marimo",
    "language": "python",
    "branch": "main",
    "sha": "cc4d597a556806fc796e2188471c60d62fb3308c",
    "stars": 23227,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "PrefectHQ/fastmcp",
    "language": "python",
    "branch": "main",
    "sha": "7f3c53eadf6bb1b7194e00c42551e4db380b3f67",
    "stars": 28116,
    "agentFiles": [
      ".claude",
      ".cursor",
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "PrefectHQ/prefect",
    "language": "python",
    "branch": "main",
    "sha": "87b5243845e733ed938b21cf7b9aeda6d6a4e194",
    "stars": 24032,
    "agentFiles": [
      ".claude",
      "AGENTS.md"
    ]
  },
  {
    "repo": "567-labs/instructor",
    "language": "python",
    "branch": "main",
    "sha": "035c77b7b04dbbf70ae4457eb102038907b5a2a4",
    "stars": 14027,
    "agentFiles": [
      ".cursor",
      "AGENT.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "agno-agi/agno",
    "language": "python",
    "branch": "main",
    "sha": "0aa592461b5272e6fec8c3eb1383e6b8e71ab9b6",
    "stars": 42781,
    "agentFiles": [
      ".cursorrules",
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "aio-libs/aiohttp",
    "language": "python",
    "branch": "master",
    "sha": "a53d03aa8054eb7cebce91d3a3c406a97e241e43",
    "stars": 16576,
    "agentFiles": [
      ".claude",
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "deepset-ai/haystack",
    "language": "python",
    "branch": "main",
    "sha": "c6c46c67b7ab19d9aa08290c2524c07cb185d2f1",
    "stars": 26760,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "google/adk-python",
    "language": "python",
    "branch": "main",
    "sha": "4dbb55d0a7e02f6d654244e42506bc220ba285ba",
    "stars": 21894,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "mem0ai/mem0",
    "language": "python",
    "branch": "main",
    "sha": "0724291bd864cf807e88ee8981c8226644e8fb42",
    "stars": 67363,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "pydantic/logfire",
    "language": "python",
    "branch": "main",
    "sha": "ac9722e5193160b9cc1e666721053e06c7abf0dc",
    "stars": 4517,
    "agentFiles": [
      ".claude",
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "scrapy/scrapy",
    "language": "python",
    "branch": "master",
    "sha": "32579047288e06656d10b7fe97fc9acb092de8ad",
    "stars": 64871,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "microsoft/markitdown",
    "language": "python",
    "branch": "main",
    "sha": "4cc9fa17653d695d64fb9eee5b33d4de55ff84e8",
    "stars": 190784,
    "agentFiles": []
  },
  {
    "repo": "gradio-app/gradio",
    "language": "python",
    "branch": "main",
    "sha": "de986c72372e233ffaaa7abe1b93608d4d115065",
    "stars": 43790,
    "agentFiles": [
      ".claude",
      "AGENTS.md"
    ]
  },
  {
    "repo": "pytest-dev/pytest",
    "language": "python",
    "branch": "main",
    "sha": "420cf37a3fc8c03c9a4769c2635a03773d27be10",
    "stars": 14606,
    "agentFiles": []
  },
  {
    "repo": "pmndrs/zustand",
    "language": "typescript",
    "branch": "main",
    "sha": "d7a5583cffd80af515f7dfb69583c95cbdc9e2ce",
    "stars": 58830,
    "agentFiles": []
  },
  {
    "repo": "pmndrs/jotai",
    "language": "typescript",
    "branch": "main",
    "sha": "dceab08751320d2bfd707e7a54a880db73d7a069",
    "stars": 21297,
    "agentFiles": []
  },
  {
    "repo": "TanStack/query",
    "language": "typescript",
    "branch": "main",
    "sha": "1099ebb4446bb6357e1c2dc849866ee14e3d6a96",
    "stars": 50450,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "TanStack/router",
    "language": "typescript",
    "branch": "main",
    "sha": "b1b111761bdfa7a0582f28ea78ee81fe7c59ed99",
    "stars": 15214,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "honojs/hono",
    "language": "typescript",
    "branch": "main",
    "sha": "5ca49b0720755c585c9a9835f0a479ceea36fb52",
    "stars": 32576,
    "agentFiles": []
  },
  {
    "repo": "trpc/trpc",
    "language": "typescript",
    "branch": "main",
    "sha": "6d92747fa267c51829ec99242be15e0ed968d0de",
    "stars": 40709,
    "agentFiles": [
      ".cursor"
    ]
  },
  {
    "repo": "drizzle-team/drizzle-orm",
    "language": "typescript",
    "branch": "main",
    "sha": "eab8bedbb65d5429c54e612ddbd88aa23091d398",
    "stars": 36069,
    "agentFiles": []
  },
  {
    "repo": "vitest-dev/vitest",
    "language": "typescript",
    "branch": "main",
    "sha": "fb150158b3499ae9e2bd52defd90b0a09b860424",
    "stars": 17254,
    "agentFiles": [
      ".claude",
      "AGENTS.md"
    ]
  },
  {
    "repo": "vitejs/vite",
    "language": "typescript",
    "branch": "main",
    "sha": "df7503cc499e0b49e45701e3be7546918ee9d322",
    "stars": 83376,
    "agentFiles": []
  },
  {
    "repo": "sveltejs/svelte",
    "language": "typescript",
    "branch": "main",
    "sha": "40bb08482f4857d91221638dec544a532bc35389",
    "stars": 88401,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "vuejs/core",
    "language": "typescript",
    "branch": "main",
    "sha": "bf5f0dd877dd3c23ce85c2cbc1dd771567e84c8c",
    "stars": 54658,
    "agentFiles": []
  },
  {
    "repo": "remix-run/react-router",
    "language": "typescript",
    "branch": "main",
    "sha": "ba64bc919b9e7100fa94825ab44d51f1b76c39f1",
    "stars": 56612,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "shadcn-ui/ui",
    "language": "typescript",
    "branch": "main",
    "sha": "d2fba50ee5b9113008b5bb908563527b7efd2f27",
    "stars": 125823,
    "agentFiles": [
      ".claude"
    ]
  },
  {
    "repo": "excalidraw/excalidraw",
    "language": "typescript",
    "branch": "master",
    "sha": "4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e",
    "stars": 134064,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "axios/axios",
    "language": "typescript",
    "branch": "v1.x",
    "sha": "326843a3902d73c9f6af9bad7b55e2412566a251",
    "stars": 109299,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "google-gemini/gemini-cli",
    "language": "typescript",
    "branch": "main",
    "sha": "ed96faedfd5571f055c44f2c9509d62321d1138d",
    "stars": 107430,
    "agentFiles": [
      "GEMINI.md"
    ]
  },
  {
    "repo": "openai/openai-node",
    "language": "typescript",
    "branch": "main",
    "sha": "e989fc07033981150d68c4e06e8600452b46494c",
    "stars": 11225,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "anthropics/anthropic-sdk-typescript",
    "language": "typescript",
    "branch": "main",
    "sha": "04a4c28c70de498d6d0e930e43edb5edb9ac545e",
    "stars": 2144,
    "agentFiles": [
      "CLAUDE.md"
    ]
  },
  {
    "repo": "langchain-ai/langchainjs",
    "language": "typescript",
    "branch": "main",
    "sha": "84eca2b11c0900a67775dca258ebec04f8e852a2",
    "stars": 18275,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "modelcontextprotocol/inspector",
    "language": "typescript",
    "branch": "main",
    "sha": "074b8108f340590268f2900741403755e923a11c",
    "stars": 11092,
    "agentFiles": [
      ".claude",
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "statelyai/xstate",
    "language": "typescript",
    "branch": "main",
    "sha": "6a85c4057dc7c0906381664249e0b1bac300cd92",
    "stars": 30317,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "elysiajs/elysia",
    "language": "typescript",
    "branch": "main",
    "sha": "e037eca710e7ad193be09cc6615ab0dbe54af914",
    "stars": 19256,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "h3js/h3",
    "language": "typescript",
    "branch": "main",
    "sha": "d8d726f065b60b6d9fbb5c2799c9251c647ffda9",
    "stars": 5464,
    "agentFiles": [
      "AGENTS.md",
      "CLAUDE.md"
    ]
  },
  {
    "repo": "nuxt/nuxt",
    "language": "typescript",
    "branch": "main",
    "sha": "12156d1df27ff52facfeb0e7e2edd344d6faad22",
    "stars": 60963,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "withastro/astro",
    "language": "typescript",
    "branch": "main",
    "sha": "c75e89711a4935a0befea6f768842f6d6a9de2bb",
    "stars": 63300,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "fastify/fastify",
    "language": "typescript",
    "branch": "main",
    "sha": "e03b48ba3cd92dcbdafcb624579318e0f22176d2",
    "stars": 37285,
    "agentFiles": []
  },
  {
    "repo": "expressjs/express",
    "language": "typescript",
    "branch": "master",
    "sha": "0dee2c52c7c873498f8ed7d8ee4ddd0a04d3ada8",
    "stars": 69576,
    "agentFiles": []
  },
  {
    "repo": "cli/cli",
    "language": "go",
    "branch": "trunk",
    "sha": "fa92838bef95fe4a29c1587693885d5e9bdb6cf1",
    "stars": 46677,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "gofiber/fiber",
    "language": "go",
    "branch": "main",
    "sha": "40be9a581e77944ee5e32c05dcb072de81896550",
    "stars": 40217,
    "agentFiles": [
      "AGENTS.md"
    ]
  },
  {
    "repo": "labstack/echo",
    "language": "go",
    "branch": "master",
    "sha": "8fd0e184dd390ffdf082f5eda247c3ab41d5d290",
    "stars": 32773,
    "agentFiles": [
      "CLAUDE.md"
    ]
  },
  {
    "repo": "gin-gonic/gin",
    "language": "go",
    "branch": "master",
    "sha": "0f09c3a9b4626d9fe9979cf4d0521d6ae32ab646",
    "stars": 89369,
    "agentFiles": []
  },
  {
    "repo": "spf13/viper",
    "language": "go",
    "branch": "master",
    "sha": "528f7416c4b56a4948673984b190bf8713f0c3c4",
    "stars": 30490,
    "agentFiles": []
  }
];
