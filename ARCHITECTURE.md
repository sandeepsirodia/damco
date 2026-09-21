# Architecture

Reference diagrams for Spec Clarity's system design, data flow, and failure
handling. See `README.md` for setup/usage and the full eval writeup.

## 1. System components

Two layers, kept deliberately decoupled: the chat orchestration (CopilotKit,
decides *when* to call a REST action) and the pipeline (plain REST API, has
no idea a chat exists).

```mermaid
graph TB
    subgraph Browser["Browser"]
        UI["Chat UI<br/>React + CopilotKit headless"]
        Picker["Folder Picker<br/>(Browse button)"]
    end

    subgraph Server["Express Server"]
        CK["CopilotKit Runtime<br/>src/copilotkit.js<br/>-- decides WHEN to call a tool"]
        API["REST API<br/>src/routes/sessions.js"]
        FS["src/routes/fs.js<br/>-- confined to FS_BROWSE_ROOT"]
        Pipeline["9-Stage Pipeline<br/>src/pipeline/*.js"]
        LLM["LLM Adapter<br/>src/llm/index.js<br/>complete() / completeJson()"]
    end

    DB[("Postgres<br/>sessions, questions, findings,<br/>open_questions, documents")]
    Provider["LLM Provider<br/>Gemini / OpenAI / Anthropic<br/>(one env var picks it)"]
    GitHubAPI["GitHub REST API<br/>(opt-in, PAT per-request)"]
    Langfuse["Langfuse<br/>(optional tracing)"]

    UI -- "tool call args" --> CK
    CK -- "startFeatureSpec /<br/>submitFeatureAnswers /<br/>pushToGithub" --> API
    Picker -- "GET /api/fs/list" --> FS
    API --> Pipeline
    Pipeline --> LLM
    LLM --> Provider
    CK -.->|conversational routing model| Provider
    Pipeline --> DB
    API --> DB
    Pipeline -- "stage 9" --> GitHubAPI
    LLM -.->|every call traced here| Langfuse
```

## 2. Request flow — one full session

Two REST round-trips, matching the two halves of the pipeline: intake
(before answers exist) and analysis (after).

```mermaid
sequenceDiagram
    actor User
    participant Chat as Chat UI
    participant Agent as CopilotKit Agent
    participant API as REST API
    participant Pipe as Pipeline
    participant DB as Postgres

    User->>Chat: feature description + repo
    Chat->>Agent: message
    Agent->>API: POST /api/sessions (startFeatureSpec)
    API->>Pipe: runIntake()
    Note over Pipe: 1. Repo Reader<br/>2. Clarification Agent (LLM)
    Pipe->>DB: INSERT session, questions
    API-->>Agent: 5 grounded questions
    Agent-->>Chat: numbered list

    User->>Chat: answers some, not all
    Chat->>Agent: message
    Agent-->>Chat: "Answered X/N, Remaining Y/N"<br/>(fixed template, no tool call yet)

    User->>Chat: "skip the rest"
    Chat->>Agent: message
    Agent->>API: POST /sessions/:id/answers (submitFeatureAnswers)
    API->>Pipe: runAnalysis()
    Note over Pipe: 3. Blast Radius<br/>4. Edge Cases (LLM)<br/>5. Classifier (LLM)<br/>6. Estimate (pure logic)<br/>7. Doc Generator (LLM)<br/>8. Coverage Gate (pure logic)
    Pipe->>DB: INSERT findings, open_questions, documents
    API-->>Agent: PRD/TRD, estimate, blast radius
    Agent-->>Chat: renders ResultsCard
```

## 3. Pipeline stages

Blue = LLM call. Green = pure deterministic code (no model, unit-tested).

```mermaid
flowchart LR
    classDef llm fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a
    classDef pure fill:#dcfce7,stroke:#15803d,color:#14532d

    S1["1. Repo Reader"]:::pure --> S2["2. Clarification<br/>Agent"]:::llm
    S2 --> S3["3. Blast Radius"]:::pure
    S3 --> S4["4. Edge Cases"]:::llm
    S4 --> S5["5. Classifier"]:::llm
    S5 --> S6["6. Estimate"]:::pure
    S6 --> S7["7. Doc Generator"]:::llm
    S7 --> S8["8. Coverage Gate"]:::pure
    S8 -.->|opt-in, needs a PAT| S9["9. GitHub<br/>Write-back"]:::pure

    subgraph Intake["runIntake() -- stages 1-2"]
        S1
        S2
    end
    subgraph Analysis["runAnalysis() -- stages 3-8"]
        S3
        S4
        S5
        S6
        S7
        S8
    end
```

## 4. Failure modes

What breaks, and what the system does about it today.

```mermaid
flowchart TD
    A["Invalid repo path /<br/>unreachable GitHub URL"] -->|readRepo throws| A1["Chat states the error plainly.<br/>Never claims the repo was read."]
    B["Repo dir gone before analysis<br/>(stale clone, deleted local path)"] -->|blastRadius.js checks existsSync first| B1["Throws a clear error --<br/>NOT a silent count: 0"]
    C["GitHub issue creation<br/>fails partway (e.g. rate limit)"] -->|per-issue try/catch, not one big throw| C1["Returns whichever issues succeeded<br/>+ named errors for the rest"]
    D["LLM wraps JSON in prose<br/>despite being told not to"] -->|parseJson.js, 3-tier recovery| D1["direct parse -> fenced-with-prose<br/>-> raw JSON inside prose"]
    E["Folder browser asked for<br/>a path outside the allowed root"] -->|fs.js allowlist check| E1["403 -- refuses to list it"]

    classDef fixed fill:#dcfce7,stroke:#15803d,color:#14532d
    class A1,B1,C1,D1,E1 fixed
```

**Known, not fixed — documented in `README.md`, not hidden:**
- Blast radius tallies by filename only: this repo has three unrelated
  `index.js` files that collide under one key and all report the same wrong
  count. Real fix is a proper dependency graph (madge/dependency-cruiser).
- The GitHub PAT is collected through chat, so it transits whichever LLM
  provider is configured before reaching this backend. Fixing it needs a
  separate, out-of-band input path — not built.
- No rate-limiting anywhere in the API yet.
