## Progress
progress
- [x] Requirements Analysis
- [x] Mockup Design
- [ ] Confirm Front-page Design
- [ ] Implement Backend
- [ ] Validate Implementation
- [ ] Deliver to User


## Questions, Comments, Suggestions

```text
We are shifting to a new authentication portal ....
```

## Reference
taskTypes/html-web-ui-design/html-web-ui-design.md

## Tech Stack

| Library             | Version | Main use                 | Download |
| ------------------- | ---------------- | ------------------------ | ------------------------|
| Mermaid.js          |           11.15.0 | Diagrams                 | to-html/mermaid/mermaid.min.js |
| PrismJS             |              1.30 | Code highlighting        |  |

## Download Mockup Package

[Mockup 1](package/single-html.zip)  [Mockup 2](package/single-html.zip)

## Confirm Mockup Design

[] Mockup 1 [x] Mockup 2 [x] [confirm]

## Mockup 1

img/website_bird_protection.png

## Search Workflow

flowchart TD
    A[User enters search query] --> B[Search Frontend]

    B --> C[Query Understanding]
    C --> C1[Spell correction]
    C --> C2[Intent detection]
    C --> C3[Entity recognition]
    C --> C4[Language and location context]

    C --> D[Retrieve Candidate Pages]

    subgraph Indexing Pipeline
        E[Web Crawlers / bot] --> F[Fetch web pages]
        F --> G[Parse HTML, links, media, metadata]
        G --> H[Render JavaScript when needed]
        H --> I[Extract content and signals]
        I --> J[Build Search Index]
    end

    J --> D

    D --> K[Ranking System]
    K --> K1[Relevance to query]
    K --> K2[Page quality]
    K --> K3[Freshness]
    K --> K4[Authority / links]
    K --> K5[User context]
    K --> K6[Spam and policy filters]

    K --> L[Generate Search Results Page]

    L --> L1[Organic results]
    L --> L2[Featured snippets]
    L --> L3[Knowledge panels]
    L --> L4[Images / videos / maps]
    L --> L5[Ads, clearly separated]

    L --> M[User clicks or refines query]

    M --> N[Feedback Signals]
    N --> O[Improve ranking models]
    O --> K
	
