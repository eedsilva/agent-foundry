# Agent Foundry: roadmap até uma experiência Lovable-class

Repositório alvo: `eedsilva/agent-foundry`

Escopo gerado: **12 milestones**, **12 epics**, **88 sub-issues de trabalho** e **1 issue raiz**.

## Contrato do alvo

- Construção iterativa por conversa, com modos de planejar e executar.
- Preview navegável, edição visual, histórico e revert.
- Verificação determinística e por browser.
- Backend por projeto com database, auth, storage, functions e secrets.
- GitHub two-way sync, publicação, custom domains e rollback.
- Workspaces, colaboração, quotas, billing e isolamento multi-tenant.

O roadmap evita datas artificiais. Cada milestone fecha por critérios de saída verificáveis.

## Visão por versão

| Versão | Resultado | Sub-issues |
|---|---|---:|
| v0.2 - Reliable Runs | Execuções reais, canceláveis, retomáveis e auditáveis, com recuperação após falhas. | 9 |
| v0.3 - Human Control | Aprovações humanas, políticas de projeto e limites explícitos de execução. | 6 |
| v0.4 - Existing Repositories | Importação de repositórios, worktrees isolados e change requests incrementais. | 7 |
| v0.5 - Live Preview | Preview executável, logs de browser e verificação Playwright reproduzível. | 7 |
| v0.6 - Conversational Builder | Chat iterativo, modos Plan/Build, version history e edição visual ligada ao código. | 8 |
| v0.7 - Secure Execution | Control plane separado, sandboxes efêmeros e políticas de recursos, rede e segredos. | 7 |
| v0.8 - Production Data Plane | PostgreSQL, object storage, fila durável, observabilidade e recuperação operacional. | 7 |
| v0.9 - Adaptive Routing | Benchmarks próprios, telemetria normalizada e roteamento com confiança e guardrails. | 7 |
| v0.10 - Full-stack App Platform | Ambientes por projeto com banco, auth, storage, functions, secrets e portabilidade. | 8 |
| v0.11 - Publish and Integrations | Publicação, domínios, GitHub two-way sync e conectores externos. | 7 |
| v0.12 - SaaS and Collaboration | Autenticação, workspaces, RBAC, colaboração, créditos e billing. | 8 |
| v1.0 - Lovable-class Release | Produto completo de prompt a app full-stack publicado, iterável e colaborativo. | 7 |

## v0.2 - Reliable Runs

Transformar o MVP batch em um motor confiável. A release valida Codex, Claude e AGY em tarefas reais e torna cada run controlável, retomável e idempotente.

### Exit criteria

- [ ] Existe ao menos um canário reproduzível por provider e um relatório de baseline.
- [ ] Runs sobrevivem a crash de worker sem duplicar artefatos ou commits.
- [ ] Cancel, pause, resume e retry por step funcionam até o processo da CLI.
- [ ] A UI acompanha o workflow em tempo real e permite diagnosticar cada attempt.

### Non-goals

- PostgreSQL ou fila distribuída de produção.
- Multi-tenancy e execução de código não confiável.
- Otimização avançada do Model Router.

### Epic e sub-issues

- **Epic:** `[Epic v0.2] Reliable Runs`
  - `v02-provider-canaries` - Executar canários reais e congelar o baseline dos três providers
  - `v02-run-domain` - Introduzir WorkflowRun, StepRun e StepAttempt como entidades persistidas
  - `v02-queue-leases` - Adicionar leases, heartbeats, fencing tokens e recuperação de jobs órfãos
  - `v02-cancellation` - Propagar cancelamento até a árvore de processos e restaurar o checkpoint
  - `v02-pause-resume` - Implementar pause e resume seguros em fronteiras de step
  - `v02-step-retry` - Permitir retry de um step com invalidação controlada dos descendentes
  - `v02-idempotency` - Garantir idempotência entre attempts, artefatos, eventos e commits
  - `v02-sse-timeline` - Transmitir eventos por SSE com replay e timeline visual da execução
  - `v02-failure-injection` - Criar suíte de failure injection para crash, timeout, rate limit e entrega duplicada

## v0.3 - Human Control

Dar ao usuário autoridade real sobre decisões, custo e risco. Gates humanos passam a ser artefatos versionados, não mensagens efêmeras.

### Exit criteria

- [ ] Workflow suporta approval gates pausáveis e retomáveis.
- [ ] Usuário aprova, rejeita ou pede mudanças pela UI com diff e contexto.
- [ ] Políticas de stack, providers, dependências e orçamento são aplicadas antes da execução.
- [ ] Toda decisão humana possui ator, timestamp, razão e efeito auditável.

### Depende de

- `v0.2`

### Non-goals

- Colaboração multiusuário em tempo real.
- Billing e créditos comerciais.

### Epic e sub-issues

- **Epic:** `[Epic v0.3] Human Control`
  - `v03-approval-domain` - Adicionar approval gates e decisões humanas ao workflow declarativo
  - `v03-approval-api-ui` - Construir API e interface de revisão para aprovar, rejeitar e pedir mudanças
  - `v03-project-policies` - Definir e aplicar ProjectPolicy para stack, providers e dependências
  - `v03-budgets-overrides` - Aplicar budgets e overrides explícitos de modelo por run ou step
  - `v03-audit-feedback` - Persistir feedback humano e identidade do ator na trilha de auditoria
  - `v03-policy-e2e` - Cobrir approval gates e políticas com testes end-to-end

## v0.4 - Existing Repositories

Parar de tratar todo pedido como greenfield. O Agent Foundry passa a entender um baseline Git, selecionar contexto e aplicar mudanças incrementais sem corromper o branch original.

### Exit criteria

- [ ] Projeto pode nascer de um repositório Git e commit base explícito.
- [ ] Cada run mutável usa branch e worktree próprios.
- [ ] Context builder seleciona arquivos por tarefa com orçamento auditável.
- [ ] Usuário envia change requests e revisa diff antes de promover.

### Depende de

- `v0.3`

### Non-goals

- Two-way sync contínuo com GitHub.
- Deploy e preview hospedado.

### Epic e sub-issues

- **Epic:** `[Epic v0.4] Existing Repositories`
  - `v04-repository-source` - Modelar RepositorySource e importar um baseline Git de forma segura
  - `v04-git-credentials` - Criar fronteira de credenciais Git sem vazar tokens para agentes
  - `v04-worktrees` - Isolar cada run mutável em branch e Git worktree próprios
  - `v04-repository-map` - Gerar repository-map com módulos, configs, símbolos e grafo de imports
  - `v04-context-selector` - Selecionar contexto por tarefa usando busca lexical, imports e orçamento
  - `v04-change-requests` - Introduzir ChangeRequest e workflow incremental sobre um baseline
  - `v04-diff-review` - Adicionar file browser, diff review e promoção do branch na interface

## v0.5 - Live Preview

Fechar o ciclo entre geração e comportamento visível. Cada run pode subir uma aplicação temporária, testá-la em browser e entregar evidência visual.

### Exit criteria

- [ ] Aplicações suportadas ganham preview URL temporária e lifecycle controlado.
- [ ] Playwright valida jornadas e produz screenshots, trace e console.
- [ ] A UI alterna desktop/mobile e mostra logs do runtime e do browser.
- [ ] Preview quebrado vira input estruturado para repair.

### Depende de

- `v0.4`

### Non-goals

- Publicação permanente e domínio customizado.
- Sandbox multi-tenant forte.

### Epic e sub-issues

- **Epic:** `[Epic v0.5] Live Preview`
  - `v05-preview-domain` - Definir PreviewSession e a porta PreviewRunner
  - `v05-runtime-detection` - Detectar package manager e comandos de install, build e dev
  - `v05-preview-network` - Descobrir porta e expor preview por reverse proxy com isolamento básico
  - `v05-preview-lifecycle` - Gerenciar health, restart, timeout e coleta de logs do preview
  - `v05-playwright` - Adicionar BrowserVerifier com Playwright e test plans versionados
  - `v05-preview-artifacts` - Persistir screenshots, trace, vídeo opcional e logs como artifacts
  - `v05-preview-ui-e2e` - Construir painel de preview responsivo e fechar golden flow end-to-end

## v0.6 - Conversational Builder

Mudar a experiência de PRD batch para um builder iterativo. Conversa, preview e diff passam a compartilhar o mesmo contexto versionado.

### Exit criteria

- [ ] Usuário alterna Plan e Build sem perder contexto.
- [ ] Cada mensagem gera uma operação rastreável e pode incluir imagem ou seleção visual.
- [ ] Versões podem ser comparadas, revertidas e ramificadas.
- [ ] Seleção de componente no preview produz patch de código verificável.

### Depende de

- `v0.5`

### Non-goals

- Editor de código completo no browser.
- Colaboração multiusuário em tempo real.

### Epic e sub-issues

- **Epic:** `[Epic v0.6] Conversational Builder`
  - `v06-conversation-domain` - Modelar Conversation, Message, Attachment e Operation
  - `v06-plan-build-modes` - Implementar modos Plan e Build com contratos de saída distintos
  - `v06-chat-operations` - Converter mensagens em change requests incrementais e handoffs reproduzíveis
  - `v06-chat-streaming` - Transmitir tokens, tool calls e progresso dos agentes dentro do chat
  - `v06-version-history` - Adicionar version history, compare, revert e branch de uma versão
  - `v06-dom-source-map` - Mapear elemento selecionado no preview para componente e origem no código
  - `v06-visual-patches` - Aplicar edições visuais como patches estruturados e verificáveis
  - `v06-knowledge-attachments-shell` - Adicionar knowledge files, imagens e shell de três painéis do builder

## v0.7 - Secure Execution

Parar de executar código gerado com os privilégios do host. Criar uma fronteira operacional concreta antes de aceitar entradas não confiáveis.

### Exit criteria

- [ ] Cada run hosted acontece em sandbox efêmero sem credenciais reutilizáveis.
- [ ] Filesystem, processos, CPU, memória, disco e rede possuem limites.
- [ ] Secrets entram por broker de curta duração e passam por redaction.
- [ ] Threat model e testes adversariais cobrem escape, exfiltração e cleanup.

### Depende de

- `v0.6`

### Non-goals

- Certificação formal ou microVM obrigatória em todos os ambientes.
- Multi-tenancy de produto.

### Epic e sub-issues

- **Epic:** `[Epic v0.7] Secure Execution`
  - `v07-control-execution-plane` - Separar control plane e execution plane por um protocolo explícito
  - `v07-sandbox-runner` - Definir SandboxRunner e lifecycle create, exec, snapshot e destroy
  - `v07-container-backend` - Implementar backend de sandbox em container rootless
  - `v07-network-policy` - Bloquear rede por padrão e liberar egress por policy
  - `v07-secret-broker` - Entregar secrets efêmeros por broker e redigir saídas
  - `v07-cache-supply-chain` - Criar cache seguro de dependências e controles básicos de supply chain
  - `v07-threat-model` - Publicar threat model e suíte adversarial de isolamento

## v0.8 - Production Data Plane

Trocar adapters locais por uma implementação transacional e distribuível sem contaminar o domínio.

### Exit criteria

- [ ] Metadados críticos vivem em PostgreSQL com migrations e constraints.
- [ ] Blobs grandes usam object storage e links assinados.
- [ ] Fila possui leases transacionais, backpressure e outbox.
- [ ] Tracing conecta request, job, run, step, attempt, provider e deploy.

### Depende de

- `v0.7`

### Non-goals

- Kubernetes como requisito.
- Escala global multi-região.

### Epic e sub-issues

- **Epic:** `[Epic v0.8] Production Data Plane`
  - `v08-postgres` - Implementar schema PostgreSQL e adapters das portas de domínio
  - `v08-object-storage` - Mover blobs grandes para object storage com integridade e retenção
  - `v08-durable-queue` - Implementar fila de produção com leases, retry e transactional outbox
  - `v08-event-fanout` - Distribuir eventos e SSE sem depender do filesystem local
  - `v08-scheduler` - Adicionar scheduler de workers, concorrência e backpressure por recurso
  - `v08-observability` - Instrumentar logs, métricas e traces com OpenTelemetry
  - `v08-ops-migration` - Entregar backup, restore, retenção e migração do storage local

## v0.9 - Adaptive Routing

Trocar priors subjetivos por decisões baseadas em evidência do próprio workload, sem entregar o controle a uma caixa-preta prematura.

### Exit criteria

- [ ] Taxonomia diferencia tarefas e riscos relevantes.
- [ ] Benchmark reproduzível mede qualidade, tempo e consumo até aprovação.
- [ ] Router reporta score, confiança, sample size e razão.
- [ ] Exploração é controlada e proibida em tarefas de alto risco.

### Depende de

- `v0.8`

### Non-goals

- Treinar modelo próprio.
- Garantir um modelo globalmente ótimo.

### Epic e sub-issues

- **Epic:** `[Epic v0.9] Adaptive Routing`
  - `v09-task-taxonomy` - Expandir TaskKind para uma taxonomia hierárquica e versionada
  - `v09-usage-telemetry` - Normalizar tokens, custo, quota e rate limits entre providers
  - `v09-benchmark-runner` - Criar corpus de tarefas e benchmark runner reproduzível
  - `v09-quality-signals` - Combinar checks determinísticos, blind review e feedback humano em quality signals
  - `v09-confidence-routing` - Adicionar confiança, sample size e calibração à decisão do router
  - `v09-exploration-health` - Implementar exploração controlada, circuit breakers e provider health
  - `v09-router-dashboard` - Construir dashboard de router e registry de experimentos

## v0.10 - Full-stack App Platform

Entregar o equivalente funcional de um backend gerenciado para os apps produzidos, sem misturar o control plane do Agent Foundry com o runtime do app.

### Exit criteria

- [ ] Projeto pode provisionar ambiente full-stack isolado.
- [ ] Agente cria schema, auth, storage e functions com migrations revisáveis.
- [ ] Secrets e integrações são scoped por projeto.
- [ ] Usuário consegue exportar código e dados sem lock-in obrigatório.

### Depende de

- `v0.9`

### Non-goals

- Escala automática global.
- Compatibilidade com toda stack possível.

### Epic e sub-issues

- **Epic:** `[Epic v0.10] Full-stack App Platform`
  - `v010-environment-provisioner` - Definir AppEnvironment e a porta EnvironmentProvisioner
  - `v010-database` - Provisionar PostgreSQL por projeto e gerenciar schema por migrations
  - `v010-auth` - Integrar autenticação e gerar fluxos seguros de usuário
  - `v010-storage` - Provisionar storage de arquivos com policies e uploads seguros
  - `v010-functions` - Adicionar runtime de serverless/edge functions com deploy versionado
  - `v010-app-secrets` - Criar secret store e runtime de conexões por projeto
  - `v010-data-security` - Verificar RLS, autorização e operações destrutivas antes de release
  - `v010-fullstack-reference` - Entregar workflow e app de referência full-stack com export portátil

## v0.11 - Publish and Integrations

Levar o projeto de preview a produto publicado, preservando propriedade do código e integração com ferramentas externas.

### Exit criteria

- [ ] Versões podem ser promovidas para production e revertidas.
- [ ] Custom domain e TLS possuem verificação e status claros.
- [ ] GitHub mantém sync bidirecional com política de conflitos.
- [ ] Connector SDK suporta pelo menos pagamentos e email como referências.

### Depende de

- `v0.10`

### Non-goals

- Marketplace público de conectores.
- Deploy em qualquer provedor imaginável.

### Epic e sub-issues

- **Epic:** `[Epic v0.11] Publish and Integrations`
  - `v011-deployment-domain` - Definir Release, Deployment e a porta DeploymentProvider
  - `v011-publish-domains` - Implementar publish pipeline, custom domains e TLS
  - `v011-github-app` - Integrar GitHub App/OAuth com permissões mínimas por repositório
  - `v011-github-sync` - Implementar two-way sync, pull requests e resolução de conflitos
  - `v011-connector-sdk` - Criar Connector SDK com OAuth, scopes, actions e secret refs
  - `v011-reference-connectors` - Entregar conectores de referência para Stripe e email transacional
  - `v011-release-ui-e2e` - Construir painel de releases, domains, GitHub e connectors com golden flow

## v0.12 - SaaS and Collaboration

Transformar a ferramenta pessoal em plataforma multi-tenant operável, com isolamento de dados, colaboração e modelo econômico explícito.

### Exit criteria

- [ ] Usuários e workspaces possuem RBAC aplicado em todas as portas.
- [ ] Quotas e créditos impedem consumo não autorizado.
- [ ] Billing e usage ledger reconciliam sem alterar histórico.
- [ ] Colaboração, compartilhamento e data rights funcionam por tenant.

### Depende de

- `v0.11`

### Non-goals

- Enterprise SSO completo.
- Marketplace e revenue sharing.

### Epic e sub-issues

- **Epic:** `[Epic v0.12] SaaS and Collaboration`
  - `v012-identity` - Adicionar identidade, sessão e proteção de endpoints
  - `v012-workspaces-rbac` - Modelar workspaces, memberships e RBAC por projeto
  - `v012-tenant-isolation` - Aplicar isolamento de tenant em banco, fila, blobs e sandboxes
  - `v012-collaboration` - Adicionar colaboradores, comentários, presence e atividade
  - `v012-sharing-templates` - Implementar sharing, remix e templates com proveniência
  - `v012-usage-credits` - Criar usage ledger, quotas e créditos por workspace
  - `v012-billing-connections` - Integrar billing e ownership de secrets/connections por workspace
  - `v012-governance-e2e` - Entregar audit, abuse controls, data rights e suíte multi-tenant

## v1.0 - Lovable-class Release

Fechar uma experiência Lovable-class: conversar, planejar, construir, editar visualmente, validar, provisionar backend, sincronizar código e publicar sem exigir operação manual do usuário.

### Exit criteria

- [ ] Golden journeys cobrem prompt -> app full-stack -> visual edit -> deploy -> GitHub.
- [ ] Feature contract e non-goals estão públicos e verificáveis.
- [ ] SLOs, segurança, privacy e suporte possuem gates de lançamento.
- [ ] Onboarding leva um usuário novo a um app publicado sem intervenção da equipe.

### Depende de

- `v0.12`

### Non-goals

- Paridade literal com todo recurso atual ou futuro do Lovable.
- Suporte universal a frameworks.

### Epic e sub-issues

- **Epic:** `[Epic v1.0] Lovable-class Release`
  - `v100-parity-contract` - Publicar feature contract e matriz Lovable-class
  - `v100-onboarding-templates` - Construir onboarding, template gallery e remix guiado
  - `v100-builder-polish` - Polir builder, acessibilidade, responsividade e performance percebida
  - `v100-golden-journeys` - Automatizar golden journeys ponta a ponta em ambiente semelhante à produção
  - `v100-reliability-ops` - Definir SLOs, capacity model, runbooks e incident readiness
  - `v100-security-privacy` - Concluir security review, privacy review e launch threat assessment
  - `v100-launch` - Fechar pricing UX, documentação, migração e automação de release

## Labels

| Label | Uso |
|---|---|
| `kind:roadmap` | Roadmap de produto e sequência de releases |
| `kind:epic` | Entrega grande composta por sub-issues |
| `kind:feature` | Capacidade de produto ou comportamento novo |
| `kind:infra` | Infraestrutura, runtime ou confiabilidade operacional |
| `kind:security` | Segurança, isolamento, privacidade ou abuso |
| `kind:test` | Testes, avaliação, benchmark ou quality gate |
| `kind:docs` | Documentação, onboarding ou runbooks |
| `priority:p0` | Bloqueador da versão ou risco crítico |
| `priority:p1` | Importante para a versão, mas não bloqueia todo o fluxo |
| `priority:p2` | Pode ser adiado sem quebrar o objetivo principal |
| `area:orchestrator` | Workflow engine, runs, steps e controle de execução |
| `area:executors` | Codex, Claude, AGY e execução de ferramentas |
| `area:persistence` | Repos, artefatos, filas, eventos e bancos |
| `area:api` | Contratos e endpoints HTTP |
| `area:web` | Interface Next.js e experiência do builder |
| `area:preview` | Preview, browser automation e publicação |
| `area:sandbox` | Isolamento de execução e fronteiras de segurança |
| `area:model-router` | Seleção de modelos, métricas e avaliação |
| `area:platform` | Backend gerenciado, SaaS e control plane |
| `area:integrations` | GitHub, deploy providers e conectores externos |

## Aplicação no GitHub

Pré-requisitos:

- Node.js 22+.
- `GH_TOKEN`/`GITHUB_TOKEN` com permissão de Issues no repositório, ou GitHub CLI autenticado.
- Issues habilitadas.

Dry-run:

```bash
node bootstrap-github-roadmap.mjs
```

Aplicar:

```bash
node bootstrap-github-roadmap.mjs --apply
```

Reconciliar itens já gerados com o spec:

```bash
node bootstrap-github-roadmap.mjs --apply --reconcile
```

O script usa markers HTML para ser idempotente, cria a hierarquia Roadmap -> Epic -> Sub-issue e adiciona dependências sequenciais entre epics.
