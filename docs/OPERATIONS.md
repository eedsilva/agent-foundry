# Operação e evolução

## Modos de execução

### Mock

```env
EXECUTOR_MODE=mock
```

O registry devolve um executor determinístico para todos os providers. É o modo correto para desenvolvimento do motor, CI e testes de integração.

### Real

```env
EXECUTOR_MODE=real
RUN_WORKER_INLINE=false
```

O worker precisa encontrar `codex`, `claude` e `agy` no `PATH`, além de sessões autenticadas. O adapter do AGY requer versão 1.1.1 ou superior. Use `npm run doctor` antes de iniciar.

### Canary real dos providers

Valide versões, autenticação e flags sem invocar modelos:

```bash
EXECUTOR_MODE=real npm run doctor -- --json
```

Codex e Claude expõem status de autenticação dedicado. O AGY 1.1.2 não expõe `agy auth status`; o doctor usa `agy models` como probe autenticado e valida estritamente o formato da lista sem enviar prompt ou invocar modelo.

O canary real exige opt-in explícito, executa planejamento, implementação greenfield e reparo em um repositório Git temporário independente para cada provider, e falha se houver skip, modelo executado desconhecido ou verificação incompleta:

A verificação compara diretamente os arquivos com o fixture imutável e também rejeita alterações no `HEAD`, flags de índice do Git e exclusões locais; os arquivos de controle do runner ficam fora do repositório entregue ao provider.

```bash
CODEX_CANARY_MODEL="gpt-5.6-sol" \
CLAUDE_CANARY_MODEL="sonnet" \
AGY_CANARY_MODEL="Gemini 3.1 Pro (Low)" \
EXECUTOR_MODE=real \
RUN_REAL_PROVIDER_CANARIES=true \
npm run canary:providers -- --freeze
```

O AGY recebe `--new-project` em cada execução para vincular corretamente o repositório temporário em vez de reutilizar um projeto em cache. Os repositórios temporários e logs de metadata são removidos; falhas persistem somente diagnósticos normalizados e ignorados em `.data/provider-canaries/`. Nunca envie stdout/stderr bruto de provider para Git.

O baseline congelado está em [`docs/baselines/v0.2-provider-canaries.json`](baselines/v0.2-provider-canaries.json), com uma leitura humana em [`docs/baselines/v0.2-provider-canaries.md`](baselines/v0.2-provider-canaries.md). Reverta esses dois arquivos e a mudança de adapter em conjunto se o baseline precisar ser retirado.

## Topologias

### Local simples

```bash
npm run dev:inline
```

API e worker compartilham processo. Bom para desenvolvimento, ruim para isolamento e escalabilidade.

### Local separado

```bash
npm run dev
```

API, worker e web em processos separados. Um crash de agente não derruba necessariamente a interface.

### Docker mock

```bash
docker compose up --build
```

Usa volume para dados e não injeta credenciais de CLI.

## Recovery manual da fila

Por padrão, um job de projeto tem uma única tentativa de orquestração. Fallbacks de modelo e loops de reparo já acontecem dentro dessa tentativa; repetir o workflow inteiro automaticamente pode duplicar custo e revisões. O endpoint de retry torna uma nova execução uma decisão explícita.

A fila possui:

```text
queue/pending
queue/processing
queue/completed
queue/failed
```

Um crash entre `claim` e `ack/nack` deixa o job em `processing`, mas agora com lease: `claim` grava `workerId`, `heartbeatAt`, `expiresAt` e um `fencingToken` monotônico no próprio job. O worker renova o heartbeat periodicamente (`QUEUE_HEARTBEAT_INTERVAL_MS`) enquanto o `WorkflowRun` executa. Um `QueueLeaseReaper` roda em paralelo (`QUEUE_REAP_INTERVAL_MS`) e devolve para `pending` qualquer job cuja lease expirou (`QUEUE_LEASE_MS`) sem renovação, emitindo um evento `queue.job_recovered` no projeto. `ack` e `nack` rejeitam um `fencingToken` obsoleto, então um worker que perdeu a lease não consegue mais concluir o job depois que outro worker o reclamou.

Isso cobre o caso de crash abrupto (processo morto, host reiniciado) sem intervenção manual. Recovery manual continua necessário apenas se o reaper estiver parado (nenhum worker e nenhuma API com `RUN_WORKER_INLINE=true` em execução) ou para investigar um job preso por outro motivo:

1. inspecione o arquivo em `processing`;
2. remova o sufixo do worker do nome;
3. mova-o de volta para `pending`;
4. reinicie o worker.

Faça isso apenas depois de confirmar que nenhum worker ainda executa o job. Caso contrário, haverá execução duplicada.

## Idempotência

A retomada completa ainda não é idempotente. Reexecutar um projeto cria um novo `WorkflowRun`, preservando runs, steps e attempts anteriores, mas ainda pode criar novas revisões e commits. O Git reduz corrupção, mas não garante exactly-once.

Lease com expiração e fencing token na fila já existem (seção anterior). Uma evolução robusta ainda deve incluir:

- chave idempotente por step e iteração;
- chave de deduplicação para o status já persistido de cada step/attempt;
- resume a partir do último checkpoint aprovado;
- side effects externos com deduplicação.

## Observabilidade

Hoje existem três trilhas:

- `events.jsonl` para linha do tempo;
- `DATA_DIR/runs/` para estado consultável e versionado de run, step e attempt;
- artefatos `run-*` para contexto, harness e diagnósticos detalhados de cada attempt;
- `metrics/models.json` para roteamento.

Para produção, exporte eventos estruturados para um backend de logs e métricas, mas aplique redaction antes de enviar prompts e stdout.

Métricas úteis:

- tempo de fila;
- duração por node;
- taxa de fallback;
- taxa de aprovação por primeira tentativa;
- número de reparos;
- custo ou quota por projeto;
- falhas por executor e versão;
- defeitos descobertos após aprovação;
- intervenção humana por entrega.

## Atualização de CLIs

CLIs mudam flags e formatos. Faça upgrade deliberado:

1. fixe a versão em ambientes reproduzíveis;
2. rode health check;
3. execute testes de contrato do adapter;
4. rode um conjunto de projetos canário;
5. compare usage, artefatos e permissões;
6. só depois promova.

O comando `--version` prova presença e permite impor mínimos conhecidos, mas não compatibilidade completa. Rode um canário real após qualquer upgrade.

## Catálogo de modelos

Versione qualquer mudança em `models/catalog.yaml`. Registre:

- motivo;
- amostra usada;
- data;
- aliases reais da CLI;
- impacto esperado;
- plano de rollback.

Evite editar priors para “forçar” a escolha desejada sem dados. Nesse caso, use `allowedProviders`, tags ou uma política explícita no workflow. Manipular o score às escondidas só torna a decisão menos legível.

## Harness

Cada alteração no harness deve incrementar `version` em `harness/manifest.json`. Sem isso, duas execuções podem parecer equivalentes apesar de receber instruções diferentes.

Teste mudanças de harness em projetos fixos e compare:

- aprovação;
- retrabalho;
- tamanho do prompt;
- decisões produzidas;
- regressões de segurança.

## Migração para Postgres

Uma sequência razoável:

1. implementar `ProjectRepository`, `ArtifactStore`, `EventStore`, `JobQueue` e `MetricsRepository` em Postgres;
2. preservar os contratos do domínio;
3. usar transação para criar projeto + artefato PRD + job;
4. usar `FOR UPDATE SKIP LOCKED` ou broker com leases;
5. armazenar blobs grandes em object storage;
6. manter metadados e hashes no banco;
7. migrar por projeto e validar hashes.

Não coloque toda a lógica do orquestrador em stored procedure. O banco deve garantir consistência, não virar o novo monólito mágico.

## Escala

O primeiro gargalo provavelmente será tempo de execução e quota das CLIs, não throughput HTTP. Escale workers por classe de workload e provider, respeitando limites de assinatura.

Antes de paralelizar nodes, modele dependências explícitas. Paralelismo sem DAG correto produz conflitos de arquivos e artefatos incoerentes.

## Cancelamento

`POST /runs/:runId/cancel` é idempotente: marca o run como `cancel_requested`, emite `run.cancel_requested` e retorna o run atualizado. Repetir a chamada não duplica eventos; cancelar um run `completed` ou `failed` retorna 409.

O orquestrador observa o estado persistido do run durante a execução (`CANCEL_POLL_INTERVAL_MS`) e propaga um `AbortSignal` até `AgentExecutor.execute` e o verifier. A CLI recebe SIGTERM no grupo de processos inteiro e, após o período de graça, SIGKILL — o encerramento cobre a árvore de processos, não só o filho direto. Run, step e attempt terminam em `cancelled`; a confirmação emite `run.cancelled`.

Um step mutável cancelado antes do commit aprovado volta ao checkpoint Git criado no início do step. Nenhum artifact output é promovido depois do cancelamento confirmado, mesmo que o resultado do executor chegue após o abort.

A confirmação acontece no processo que executa o run. Um run `cancel_requested` ainda na fila é confirmado como `cancelled` quando o job for reclamado por um worker; sem worker ativo, ele permanece `cancel_requested` até um worker subir.

## Compatibilidade v0.1, migração e rollback

Não existe migração destrutiva nem backfill best-effort. Ao ler um `project.json` v0.1 sem `version`, o repositório assume versão `1`; `currentRunId` continua opcional. Jobs antigos sem `runId` também permanecem válidos: o worker cria o `WorkflowRun` antes de executar. Eventos e artefatos `run-*` existentes continuam acessíveis pelos caminhos e APIs atuais, mas não são convertidos retroativamente em `StepRun` ou `StepAttempt` porque essa relação não pode ser reconstruída sem inventar dados.

Resultados antigos de executor sem `stepRunId` e `attemptId` continuam válidos na leitura. Requests novos exigem as três identidades e todos os executores nativos as devolvem; o orquestrador usa a identidade persistida do attempt, não tenta inferir relações ausentes em resultados legados.

Antes do upgrade, faça snapshot de `DATA_DIR`. Um rollback de código não apaga `DATA_DIR/runs/`, e a versão v0.1 ignora essa árvore, mas um worker antigo pode regravar `project.json` sem `version` e `currentRunId`. Portanto, pare os workers antes de rollback, preserve o snapshot e evite alternar versões enquanto houver jobs em `processing`.

`StepAttempt.error` guarda somente nome, mensagem, código e exit code. stdout/stderr permanecem limitados aos audit artifacts locais já existentes; esses artifacts podem conter resposta do provider e devem ficar protegidos junto com `DATA_DIR`, fora de logs públicos e descrições de issue/PR.

## Backup

Em uso local, faça snapshot de todo `DATA_DIR`, incluindo `runs/`. Para restore, preserve permissões e `.git` dos workspaces. O arquivo `artifacts/index.json` pode ser reconstruído a partir das revisões, mas o MVP não inclui ferramenta automática para isso.

## Operação do Personal Builder v1

### Runtime local por projeto

Cada projeto greenfield possui nome de Compose, portas, rede, volumes e `.env` próprios. O lifecycle suportado é initialize, start, stop, inspect, migrate, seed, health e cleanup. Reset destrutivo exige confirmação e backup recente.

### Deploy em VPS existente

O deployer usa SSH para um host cadastrado pelo operador. Ubuntu LTS é a plataforma canônica; Debian é compatibilidade best effort. O preflight verifica Docker Engine, Compose, Caddy, espaço em disco, portas, permissões, clock e diretórios antes de alterar o host.

Cada app recebe diretório e Compose project isolados. O primeiro endpoint usa host/porta. Para domínio customizado, o operador cria o DNS; o deployer somente valida resolução e atualiza Caddy/TLS.

### Migrations e rollback

Migrations são artifacts revisados e forward-only. Operações destrutivas exigem approval. Rollback de aplicação restaura imagem, código e configuração anteriores, mas nunca executa down migration automaticamente. Restore de dados é um workflow separado e explícito.

### Backup de apps publicados

O scheduler cria dumps do Postgres e cópias do storage, verifica integridade, aplica retenção no VPS e transfere uma cópia para o Mac. Falha de backup aparece no builder e bloqueia operações destrutivas até ser resolvida ou aceita pelo operador.
