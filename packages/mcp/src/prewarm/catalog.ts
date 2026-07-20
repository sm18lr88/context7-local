import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseGitHubRepository } from "../local/library-id.js";
import type { PopularLibrary, PopularLibraryCandidate, PopularLibraryCatalog } from "./types.js";

interface GitHubRepositoryResult {
  full_name?: unknown;
  name?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  archived?: unknown;
  fork?: unknown;
  default_branch?: unknown;
  topics?: unknown;
}

interface GitHubSearchResponse {
  items?: unknown;
}

interface SearchSource {
  name: string;
  query: string;
  weight: number;
}

const SEARCH_SOURCES: SearchSource[] = [
  { name: "framework", query: "topic:framework stars:>500 archived:false fork:false", weight: 100 },
  { name: "library", query: "topic:library stars:>500 archived:false fork:false", weight: 98 },
  { name: "sdk", query: "topic:sdk stars:>250 archived:false fork:false", weight: 96 },
  {
    name: "web-framework",
    query: "topic:web-framework stars:>250 archived:false fork:false",
    weight: 96,
  },
  { name: "database", query: "topic:database stars:>500 archived:false fork:false", weight: 94 },
  {
    name: "machine-learning",
    query: "topic:machine-learning stars:>500 archived:false fork:false",
    weight: 92,
  },
  { name: "testing", query: "topic:testing stars:>500 archived:false fork:false", weight: 90 },
  { name: "devops", query: "topic:devops stars:>500 archived:false fork:false", weight: 88 },
  {
    name: "api-client",
    query: "topic:api-client stars:>100 archived:false fork:false",
    weight: 88,
  },
  { name: "orm", query: "topic:orm stars:>100 archived:false fork:false", weight: 88 },
  {
    name: "authentication",
    query: "topic:authentication stars:>250 archived:false fork:false",
    weight: 86,
  },
  {
    name: "observability",
    query: "topic:observability stars:>250 archived:false fork:false",
    weight: 84,
  },
  {
    name: "javascript",
    query: "language:JavaScript stars:>5000 archived:false fork:false",
    weight: 82,
  },
  {
    name: "typescript",
    query: "language:TypeScript stars:>5000 archived:false fork:false",
    weight: 84,
  },
  { name: "python", query: "language:Python stars:>5000 archived:false fork:false", weight: 84 },
  { name: "rust", query: "language:Rust stars:>2500 archived:false fork:false", weight: 82 },
  { name: "go", query: "language:Go stars:>3000 archived:false fork:false", weight: 82 },
  { name: "java", query: "language:Java stars:>3000 archived:false fork:false", weight: 80 },
  { name: "dotnet", query: "language:C# stars:>1500 archived:false fork:false", weight: 80 },
  { name: "cpp", query: "language:C++ stars:>3000 archived:false fork:false", weight: 76 },
  { name: "php", query: "language:PHP stars:>1500 archived:false fork:false", weight: 76 },
  { name: "ruby", query: "language:Ruby stars:>1500 archived:false fork:false", weight: 76 },
  { name: "swift", query: "language:Swift stars:>1500 archived:false fork:false", weight: 76 },
  { name: "kotlin", query: "language:Kotlin stars:>1000 archived:false fork:false", weight: 76 },
  { name: "dart", query: "language:Dart stars:>1000 archived:false fork:false", weight: 74 },
  { name: "elixir", query: "language:Elixir stars:>750 archived:false fork:false", weight: 72 },
  { name: "scala", query: "language:Scala stars:>1000 archived:false fork:false", weight: 72 },
];

const CURATED_LIBRARY_IDS = [
  "/facebook/react",
  "/vercel/next.js",
  "/vuejs/core",
  "/angular/angular",
  "/sveltejs/svelte",
  "/withastro/astro",
  "/nuxt/nuxt",
  "/solidjs/solid",
  "/remix-run/react-router",
  "/tailwindlabs/tailwindcss",
  "/vitejs/vite",
  "/webpack/webpack",
  "/rollup/rollup",
  "/parcel-bundler/parcel",
  "/evanw/esbuild",
  "/babel/babel",
  "/swc-project/swc",
  "/microsoft/TypeScript",
  "/nodejs/node",
  "/denoland/deno",
  "/oven-sh/bun",
  "/pnpm/pnpm",
  "/npm/cli",
  "/yarnpkg/berry",
  "/expressjs/express",
  "/fastify/fastify",
  "/koajs/koa",
  "/nestjs/nest",
  "/hapijs/hapi",
  "/adonisjs/core",
  "/trpc/trpc",
  "/honojs/hono",
  "/elysiajs/elysia",
  "/reduxjs/redux",
  "/pmndrs/zustand",
  "/TanStack/query",
  "/TanStack/router",
  "/TanStack/table",
  "/vercel/swr",
  "/apollographql/apollo-client",
  "/urql-graphql/urql",
  "/axios/axios",
  "/sindresorhus/got",
  "/lodash/lodash",
  "/date-fns/date-fns",
  "/iamkun/dayjs",
  "/immerjs/immer",
  "/colinhacks/zod",
  "/jquense/yup",
  "/hapijs/joi",
  "/react-hook-form/react-hook-form",
  "/vitest-dev/vitest",
  "/jestjs/jest",
  "/microsoft/playwright",
  "/cypress-io/cypress",
  "/storybookjs/storybook",
  "/mui/material-ui",
  "/chakra-ui/chakra-ui",
  "/radix-ui/primitives",
  "/shadcn-ui/ui",
  "/ant-design/ant-design",
  "/twbs/bootstrap",
  "/jquery/jquery",
  "/d3/d3",
  "/chartjs/Chart.js",
  "/mrdoob/three.js",
  "/pixijs/pixijs",
  "/python/cpython",
  "/django/django",
  "/pallets/flask",
  "/fastapi/fastapi",
  "/encode/starlette",
  "/encode/httpx",
  "/psf/requests",
  "/aio-libs/aiohttp",
  "/pydantic/pydantic",
  "/sqlalchemy/sqlalchemy",
  "/pytest-dev/pytest",
  "/numpy/numpy",
  "/pandas-dev/pandas",
  "/scipy/scipy",
  "/scikit-learn/scikit-learn",
  "/pytorch/pytorch",
  "/tensorflow/tensorflow",
  "/keras-team/keras",
  "/huggingface/transformers",
  "/huggingface/datasets",
  "/huggingface/accelerate",
  "/openai/openai-python",
  "/langchain-ai/langchain",
  "/run-llama/llama_index",
  "/microsoft/autogen",
  "/pydantic/pydantic-ai",
  "/fastapi/typer",
  "/astral-sh/ruff",
  "/astral-sh/uv",
  "/python-poetry/poetry",
  "/celery/celery",
  "/scrapy/scrapy",
  "/matplotlib/matplotlib",
  "/plotly/plotly.py",
  "/streamlit/streamlit",
  "/gradio-app/gradio",
  "/apache/airflow",
  "/PrefectHQ/prefect",
  "/dbt-labs/dbt-core",
  "/mlflow/mlflow",
  "/rust-lang/rust",
  "/rust-lang/cargo",
  "/tokio-rs/tokio",
  "/serde-rs/serde",
  "/tauri-apps/tauri",
  "/actix/actix-web",
  "/tokio-rs/axum",
  "/rwf2/Rocket",
  "/diesel-rs/diesel",
  "/SeaQL/sea-orm",
  "/dtolnay/anyhow",
  "/clap-rs/clap",
  "/seanmonstar/reqwest",
  "/rayon-rs/rayon",
  "/golang/go",
  "/gin-gonic/gin",
  "/labstack/echo",
  "/go-gorm/gorm",
  "/go-chi/chi",
  "/gorilla/mux",
  "/grpc/grpc-go",
  "/kubernetes/kubernetes",
  "/prometheus/prometheus",
  "/docker/cli",
  "/hashicorp/terraform",
  "/hashicorp/vault",
  "/open-telemetry/opentelemetry-go",
  "/spf13/cobra",
  "/spring-projects/spring-framework",
  "/spring-projects/spring-boot",
  "/quarkusio/quarkus",
  "/micronaut-projects/micronaut-core",
  "/google/guava",
  "/square/okhttp",
  "/square/retrofit",
  "/FasterXML/jackson-databind",
  "/junit-team/junit5",
  "/mockito/mockito",
  "/hibernate/hibernate-orm",
  "/gradle/gradle",
  "/apache/maven",
  "/JetBrains/kotlin",
  "/ktorio/ktor",
  "/dotnet/runtime",
  "/dotnet/aspnetcore",
  "/dotnet/sdk",
  "/dotnet/efcore",
  "/dotnet/maui",
  "/AvaloniaUI/Avalonia",
  "/CommunityToolkit/dotnet",
  "/JamesNK/Newtonsoft.Json",
  "/serilog/serilog",
  "/xunit/xunit",
  "/nunit/nunit",
  "/AutoMapper/AutoMapper",
  "/FluentValidation/FluentValidation",
  "/MassTransit/MassTransit",
  "/rails/rails",
  "/sinatra/sinatra",
  "/rspec/rspec",
  "/heartcombo/devise",
  "/laravel/framework",
  "/symfony/symfony",
  "/composer/composer",
  "/phpstan/phpstan",
  "/pestphp/pest",
  "/slimphp/Slim",
  "/postgres/postgres",
  "/mysql/mysql-server",
  "/mongodb/mongo",
  "/redis/redis",
  "/apache/kafka",
  "/apache/spark",
  "/elastic/elasticsearch",
  "/ClickHouse/ClickHouse",
  "/sqlite/sqlite",
  "/prisma/prisma",
  "/drizzle-team/drizzle-orm",
  "/sequelize/sequelize",
  "/typeorm/typeorm",
  "/supabase/supabase",
  "/firebase/firebase-js-sdk",
  "/aws/aws-sdk-js-v3",
  "/googleapis/google-cloud-node",
  "/Azure/azure-sdk-for-js",
  "/openai/openai-node",
  "/anthropics/anthropic-sdk-typescript",
  "/vercel/ai",
  "/grpc/grpc",
  "/protocolbuffers/protobuf",
  "/graphql/graphql-js",
  "/graphql-java/graphql-java",
];

const EXCLUDED_NAME = /(^|[-_.])(awesome|interview|roadmap|cheatsheet|dotfiles|books?)([-_.]|$)/i;
const EXCLUDED_TOPICS = new Set([
  "awesome-list",
  "books",
  "cheatsheet",
  "interview",
  "interview-questions",
  "learning-resources",
  "roadmap",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function repositoryTopics(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function score(stars: number, sourceWeight: number, sourceCount: number): number {
  return Math.round(
    Math.log10(Math.max(10, stars + 10)) * 1_000_000 +
      sourceWeight * 10_000 +
      Math.min(10, sourceCount) * 100
  );
}

function candidateFromResult(
  value: GitHubRepositoryResult,
  source: SearchSource
): PopularLibraryCandidate | undefined {
  if (value.archived === true || value.fork === true) return undefined;
  const fullName = asString(value.full_name);
  const ref = fullName ? parseGitHubRepository(fullName) : undefined;
  if (!ref || ref.version || EXCLUDED_NAME.test(ref.repo)) return undefined;
  const topics = repositoryTopics(value.topics);
  if (topics.some((topic) => EXCLUDED_TOPICS.has(topic.toLowerCase()))) return undefined;
  const stars = asNumber(value.stargazers_count) ?? 0;
  return {
    libraryId: ref.id,
    title: asString(value.name) ?? ref.repo,
    description: asString(value.description),
    stars,
    defaultBranch: asString(value.default_branch),
    sources: [source.name],
    score: score(stars, source.weight, 1),
  };
}

export function mergePopularCandidates(
  groups: Array<{ source: SearchSource; repositories: GitHubRepositoryResult[] }>,
  limit: number
): PopularLibrary[] {
  const candidates = new Map<string, PopularLibraryCandidate>();

  CURATED_LIBRARY_IDS.forEach((libraryId, index) => {
    const ref = parseGitHubRepository(libraryId);
    if (!ref) return;
    candidates.set(ref.id.toLowerCase(), {
      libraryId: ref.id,
      title: ref.repo,
      sources: ["curated"],
      score: 2_000_000_000 - index,
    });
  });

  for (const { source, repositories } of groups) {
    for (const repository of repositories) {
      const incoming = candidateFromResult(repository, source);
      if (!incoming) continue;
      const key = incoming.libraryId.toLowerCase();
      const existing = candidates.get(key);
      if (!existing) {
        candidates.set(key, incoming);
        continue;
      }
      const sources = [...new Set([...existing.sources, source.name])];
      const stars = Math.max(existing.stars ?? 0, incoming.stars ?? 0);
      const sourceWeight = Math.max(
        ...sources.map((name) => SEARCH_SOURCES.find((item) => item.name === name)?.weight ?? 100)
      );
      candidates.set(key, {
        ...incoming,
        ...existing,
        description: existing.description ?? incoming.description,
        stars,
        defaultBranch: existing.defaultBranch ?? incoming.defaultBranch,
        sources,
        score: existing.sources.includes("curated")
          ? existing.score
          : score(stars, sourceWeight, sources.length),
      });
    }
  }

  return [...candidates.values()]
    .sort(
      (left, right) => right.score - left.score || left.libraryId.localeCompare(right.libraryId)
    )
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

async function fetchSearch(
  source: SearchSource,
  token: string,
  fetchImpl: typeof fetch
): Promise<GitHubRepositoryResult[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", source.query);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "100");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "context7-local-prewarm/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub search ${source.name} returned HTTP ${response.status}: ${detail}`);
  }
  const data = (await response.json()) as GitHubSearchResponse;
  return Array.isArray(data.items) ? (data.items as GitHubRepositoryResult[]) : [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function generatePopularCatalog(options: {
  token: string;
  targetSuccessful: number;
  candidateCount: number;
  fetchImpl?: typeof fetch;
  onSource?: (source: string, completed: number, total: number) => void;
}): Promise<PopularLibraryCatalog> {
  if (!options.token) throw new Error("A GitHub token is required to generate the current catalog");
  const fetchImpl = options.fetchImpl ?? fetch;
  const groups: Array<{ source: SearchSource; repositories: GitHubRepositoryResult[] }> = [];
  for (const [index, source] of SEARCH_SOURCES.entries()) {
    const repositories = await fetchSearch(source, options.token, fetchImpl);
    groups.push({ source, repositories });
    options.onSource?.(source.name, index + 1, SEARCH_SOURCES.length);
    if (index + 1 < SEARCH_SOURCES.length) await delay(2_100);
  }
  const libraries = mergePopularCandidates(groups, options.candidateCount);
  if (libraries.length < options.targetSuccessful) {
    throw new Error(
      `Popularity sources produced only ${libraries.length} candidates for a target of ${options.targetSuccessful}`
    );
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    targetSuccessful: options.targetSuccessful,
    candidateCount: libraries.length,
    methodology:
      "Curated high-frequency Context7 libraries followed by current GitHub stars across library, framework, SDK, database, testing, infrastructure, and language ecosystem searches. Historical version IDs are excluded; failed candidates are backfilled by rank.",
    sources: SEARCH_SOURCES.map(({ name, query }) => ({ name, query })),
    libraries,
  };
}

export async function writeCatalog(path: string, catalog: PopularLibraryCatalog): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rm(path, { force: true });
  await rename(temporary, path);
}
