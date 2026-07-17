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

## Preview

A prévia em tempo real permite que desenvolvedores testem mudanças no projeto sem fazer commit. O runtime orquestra a preparação, inicialização e monitoramento de saúde de um servidor de desenvolvimento efêmero, e um proxy reverso oferece acesso seguro a esse servidor.

### Ciclo de vida da sessão

```bash
POST /projects/:projectId/preview
```

Inicia uma sessão de preview: reserva uma porta, instala dependências, inicia o servidor de dev, sonda a saúde HTTP e, quando saudável, retorna a sessão e uma URL de proxy com token (`/preview/:sessionId/?token=<token>`). O `currentRunId` do projeto, quando presente, é associado à sessão e aos seus eventos/diagnósticos. O token criptograficamente aleatório só aparece na resposta e no cookie; apenas seu SHA-256 é persistido. O serializer central dos access logs substitui valores de qualquer query key `token` (case-insensitive, inclusive key percent-encoded) antes da primeira emissão, preservando os demais dados da URL.

```bash
POST /projects/:projectId/preview/:sessionId/stop
```

Interrompe explicitamente uma sessão, terminando o processo do servidor de desenvolvimento.

```bash
GET /projects/:projectId/preview/:sessionId/logs?cursor=0&limit=200
```

Retorna stdout/stderr estruturado depois do cursor informado. `cursor` aceita somente texto decimal canônico não negativo (`0`, `1`, ...), e `limit` somente decimal canônico de 1–200 (padrão 200); vazio, whitespace, sinal, zero à esquerda, hexadecimal, notação científica e fração são rejeitados. Logs e stop retornam `404` quando a sessão não pertence ao projeto da URL, evitando acesso cruzado entre projetos.

Sessões expiram automaticamente após `PREVIEW_TTL_SECONDS` segundos (padrão 1800). Somente o entrypoint singleton do processo da API, nunca `buildApp` nem o worker, registra uma varredura determinística a cada `PREVIEW_REAP_INTERVAL_MS`; varreduras não se sobrepõem e erros agregados são registrados. O scheduler liga um `stop()` idempotente ao hook `onClose` do Fastify: qualquer chamada a `app.close()` cancela ticks futuros e aguarda uma varredura ativa já tratada antes de concluir. Após expiração, tentativas de proxy retornam `403`.

### Configuração e armazenamento

| Variável                           | Padrão    | Função                                         |
| ---------------------------------- | --------- | ---------------------------------------------- |
| `PREVIEW_TTL_SECONDS`              | `1800`    | validade da sessão saudável                    |
| `PREVIEW_STARTUP_TIMEOUT_MS`       | `10000`   | janela para o servidor ficar saudável          |
| `PREVIEW_HEALTH_PATH`              | `/`       | caminho da sonda HTTP                          |
| `PREVIEW_HEALTH_INTERVAL_MS`       | `1000`    | intervalo entre sondas                         |
| `PREVIEW_HEALTH_FAILURE_THRESHOLD` | `3`       | falhas consecutivas antes de reiniciar         |
| `PREVIEW_MAX_RESTARTS`             | `2`       | reinícios automáticos antes da falha terminal  |
| `PREVIEW_REAP_INTERVAL_MS`         | `5000`    | intervalo da varredura no processo da API      |
| `PREVIEW_LOG_MAX_BYTES`            | `1000000` | retenção máxima aproximada por arquivo de logs |

O timeout de startup é aplicado em duas janelas sequenciais: primeiro o runner aguarda a confirmação do processo/porta após o spawn; depois o serviço aguarda a sonda HTTP em `PREVIEW_HEALTH_PATH`. Cada janela usa `PREVIEW_STARTUP_TIMEOUT_MS`, portanto o pior caso padrão é aproximadamente 20 segundos, além do tempo de instalação.

Cada sessão usa `DATA_DIR/previews/<sessionId>/session.json` e `logs.json`. Escritas usam locks de diretório com `owner.json` (PID positivo e token UUID único), inclusive os locks de sessão/log e `.lifecycle.lock`; owner morto ou metadata malformada e antiga são recuperados, um PID vivo nunca é desalojado apenas pela idade, e somente o token proprietário remove o lock. O arquivo de sessão contém estado versionado e digest do token, nunca o token bruto. `health.detail`, `error.message` e motivos de falha do plano de comandos passam por redaction antes da gravação; IDs, referências, paths e comandos necessários à recuperação permanecem exatos. O arquivo de logs usa cursores monotônicos, remove entradas antigas para respeitar `PREVIEW_LOG_MAX_BYTES` e aplica `redactString` antes da gravação. Falha terminal grava o artifact redigido `preview-failure-<sessionId>` com as 200 entradas disponíveis mais recentes e eventos deduplicados `preview.crashed`, `preview.restarted`, `preview.failed` e `preview.reaped`; não agenda reparo automaticamente.

`DATA_DIR`, logs, artifacts e cookies de preview continuam sendo dados sensíveis. Preview é restrito a loopback e a operador confiável; não é isolamento forte para código hostil. A recuperação de lock considera `pid` vivo no mesmo host (`process.kill(pid, 0)`). Portanto, todos os processos que compartilham `DATA_DIR` devem enxergar o mesmo namespace de PID; não compartilhe esse diretório entre containers/hosts com namespaces diferentes. Reuso extremo de PID pode manter um lock órfão até intervenção manual.

### Migração, rollback e recovery

Não há sessão legada para migrar: previews anteriores eram somente em memória. Antes do upgrade, pare previews/processos antigos e a API; sessões em memória desaparecem e novas sessões começam no formato durável. Não crie backfill inventando PID, token ou estado.

Para rollback, pare a API e os processos de preview, preserve um snapshot de `DATA_DIR/previews`, restaure o snapshot anterior ao upgrade quando necessário e só então inicie o binário antigo. A versão antiga ignora a nova árvore, mas não encerra PIDs persistidos; rollback apenas de código pode deixar servidores órfãos.

Diagnóstico e recuperação:

1. consulte o endpoint de logs, `session.json`, eventos do projeto e `preview-failure-<sessionId>`; não publique esses dados sem nova revisão de segredo;
2. confirme que o PID persistido ainda corresponde ao comando e workspace esperados antes de encerrá-lo;
3. pare a API e faça snapshot de `DATA_DIR/previews` antes de editar estado;
4. remova `.lifecycle.lock` manualmente somente depois de confirmar que o owner PID está morto no mesmo host;
5. reinicie a API: uma varredura imediata reaplica TTL, detecta órfãos/crashes, reinicia dentro do limite ou produz diagnóstico terminal; os ticks seguintes mantêm a convergência;
6. se a persistência estiver corrompida, preserve-a para análise e restaure o snapshot; não apague a árvore inteira durante investigação.

### Proxy

```bash
GET/* /preview/:sessionId/*
WebSocket /preview/:sessionId/*
```

Encaminha requisições para o servidor de desenvolvimento upstream. O proxy valida:

- **Host header**: apenas `localhost` (ou equivalente de loopback) na porta da própria API (`=== apiPort`) é permitido, defendendo contra ataques de DNS rebinding (ADR-0005, ADR-0017).
- **Token**: esperado como query param na primeira requisição (convertido para cookie HttpOnly/path-scoped) ou como cookie em requisições subsequentes. Mismatch retorna `403`.

O proxy:

- Remove o token da query string antes de enviar ao upstream, evitando que o servidor de dev o receba.
- Reescreve Location e headers relacionados para evitar que a porta interna vaze (as respostas com porta interna são convertidas para paths de proxy ou rejeitadas).
- Bloqueia redirecionamentos para URLs externas, evitando que um servidor de dev comprometido redirecione através da origem de proxy confiável.
- Mantém a sessão restrita a loopback: conexões de máquinas remotas são rejeitadas.

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

Cada execução de step recebe uma chave idempotente determinística (`sha256` de runId, nodeId, stepId, iteração, política de attempts e hashes dos inputs), gravada no `StepRun` e no metadata do artifact de saída. Em qualquer redelivery o orquestrador re-percorre o workflow inteiro: steps concluídos com a mesma chave são reutilizados (artifact e commit incluídos), registros interrompidos por crash entre a escrita do artifact e a do estado são finalizados contra o artifact órfão, e redelivery de um run terminal é no-op. Eventos com `dedupeKey` têm append idempotente, então a linha do tempo não duplica em replay. Detalhes e limites no ADR 0011.

Reexecutar um projeto (`POST /projects/:id/retry`) continua criando um novo `WorkflowRun` do zero; a idempotência acima vale dentro de um mesmo run.

## Conversas, replay e export

A conversa canônica de um projeto é criada lazily no primeiro write. Ler `GET /projects/:projectId/conversation` ou `GET /projects/:projectId/export` para um projeto antigo deriva `id`, `projectId` e `createdAt` do próprio projeto sem criar arquivo ou executar backfill.

O layout aditivo é:

```text
DATA_DIR/projects/<projectId>/conversation/
├── conversation.json
├── messages.jsonl
├── attachments.jsonl
└── operations.jsonl
```

`GET /projects/:projectId/conversation?cursor=<sequence>&limit=<n>` retorna mensagens depois do cursor, com default `cursor=0`, default `limit=50` e máximo `200`. `nextCursor` é o último sequence da página quando há mais mensagens. O response também inclui toda a metadata de attachments e operações da conversa.

`GET /projects/:projectId/conversation/stream` emite mensagens persistidas com `id: <sequence>`. Para reconnect, envie `?cursor=<sequence>` ou `Last-Event-ID`; query vence o header. Ambos aceitam somente decimal canônico não negativo. O servidor lê até 500 mensagens por poll de um segundo e envia heartbeat a cada 15 segundos. Como o cursor é exclusivo, reconnect após o último id recebido não repete esse frame.

Crie metadata em `POST /projects/:projectId/conversation/attachments` antes de referenciá-la em uma mensagem. O `mediaType` deve ser bare `type/subtype`, por exemplo `image/png`; `text/plain; charset=utf-8` é rejeitado. O slice não recebe nem serve blobs e não verifica que SHA-256/tamanho correspondem a um arquivo. Blob storage e UI ficam em #43.

Ao criar uma operação em `POST /projects/:projectId/conversation/messages/:messageId/operations`, reuse a mesma idempotency key somente para o mesmo input. Retry idêntico retorna a operação original; mudança de message, kind ou links com a mesma chave retorna `409`. O endpoint apenas persiste a operação tipada: classificação fica em #38 e execução/lifecycle em #39.

Use `GET /projects/:projectId/export` para obter schema v1 com project, conversation e todos os messages, attachments e operations. Texto/data de mensagem e nome de attachment já foram redigidos no write, mas trate o export e todo `DATA_DIR` como sensíveis.

Não há migração. Para rollback, pare API e outros writers do `DATA_DIR` e faça snapshot. O binário antigo ignora a árvore aditiva `conversation/`; ela pode permanecer sem uso para um upgrade posterior. Restaure o snapshot pré-upgrade somente quando precisar remover os novos records, e não misture writers antigos e novos.

## Controles de execução (pause, resume, retry de step)

- `POST /runs/:runId/pause` — solicita pausa; o run pausa na próxima fronteira de step (um step em andamento sempre termina). Ao pausar, grava snapshot de compatibilidade: hash do workflow, versão do harness, HEAD do workspace e hash da última revisão de cada artifact.
- `POST /runs/:runId/resume` — valida o snapshot contra o estado atual. Qualquer divergência responde `409` com diagnósticos por campo e a opção explícita de restart (`POST /projects/:id/retry`). Validação ok re-enfileira o run; steps concluídos não são reexecutados.
- `GET /runs/:runId` — trilha consultável run -> step -> attempt -> artifact -> commit.
- `GET /runs/:runId/steps/:stepRunId/retry-plan` — mostra quais steps e artifacts um retry invalidaria.
- `POST /runs/:runId/steps/:stepRunId/retry` — reexecuta só o step alvo (`preserve`) ou também os descendentes (`invalidate`). O histórico anterior nunca é sobrescrito: step runs antigos ganham `invalidatedAt`. Steps que mutam o workspace voltam ao checkpoint registrado no attempt original antes de reexecutar. Um pin opcional exige provider, modelo, ator, motivo e impacto estimado:

```json
{
  "mode": "invalidate",
  "override": {
    "modelId": "codex-gpt-5",
    "provider": "codex",
    "model": "gpt-5",
    "actor": { "kind": "user", "id": "operator-1" },
    "reason": "Reparo de alto risco requer o modelo validado",
    "estimatedImpact": "Maior latência e consumo de quota"
  }
}
```

## Overrides auditados de modelo

Crie pins de run e step em `POST /runs/:runId/model-overrides`. `modelId`, provider e modelo devem
identificar exatamente a mesma entrada habilitada no catálogo ativo; isso preserva a identidade
quando duas entradas compartilham provider/model e rejeita drift posterior do tuple. Exemplos:

```json
{
  "scope": { "kind": "run" },
  "modelId": "codex-gpt-5",
  "provider": "codex",
  "model": "gpt-5",
  "actor": { "kind": "user", "id": "operator-1", "displayName": "Operator" },
  "reason": "Fixar a rota durante a resposta ao incidente",
  "estimatedImpact": "Pode aumentar latência e consumo de quota"
}
```

```json
{
  "scope": { "kind": "step", "nodeId": "quality", "stepId": "repair" },
  "modelId": "claude-sonnet",
  "provider": "claude",
  "model": "sonnet",
  "actor": { "kind": "worker", "id": "release-controller" },
  "reason": "Pin aprovado para o reparo desta etapa",
  "estimatedImpact": "Sem fallback automático nesta etapa"
}
```

Os records são create-only. A precedência é retry da etapa, override de step mais novo, override de
run mais novo. Um pin explícito desliga fallback, mas não contorna modelo desabilitado, drift de
catálogo, ProjectPolicy, `allowedProviders` do step, limite de contexto ou capacidade de escrita no
workspace. Ator, motivo e impacto passam pelo redactor antes de chegar ao disco. Consulte a
proveniência aplicada em `RouteDecision.override` nos artifacts do attempt.

## Emergency ceiling

`GET /runs/:runId` expõe `run.execution`: `activeElapsedMs`, `activeSince`,
`consecutiveRepairs`, `lastVerifiedCheckpoint` e, quando alcançado, `ceiling.reason`,
`ceiling.reachedAt` e `ceiling.draftBranch`. O relógio para em `paused` e `awaiting_approval` e
retoma quando o run volta a executar. Se o processo cair enquanto o status persistido ainda for
`running`, o intervalo até o restart conta por segurança. O limite é inclusivo: quatro horas
(`14_400_000ms`) ou o décimo reparo consecutivo concluído. Uma aprovação de qualidade zera o
contador de reparos.

Ao alcançar o limite, o orquestrador preserva a árvore atual em `draft/<runId>`, restaura o
workspace para `lastVerifiedCheckpoint`, marca o run `failed` com código `EMERGENCY_CEILING` e
emite uma única ocorrência de `run.emergency_ceiling_reached`. Cancelamento continua tendo
precedência, inclusive durante as escritas finais do ceiling.

Inspeção e recuperação manual, no workspace do projeto:

```bash
git show --stat draft/<runId>
git diff <lastVerifiedCheckpoint>..draft/<runId>
git switch -c recover/<runId> draft/<runId>
```

Não force nem apague `draft/<runId>` enquanto o run ainda puder ser redelivered. O replay aceita
somente o draft que reconhece como seguro; ref conflitante ou worktree sujo falha fechado. Depois
de copiar ou integrar o trabalho necessário e confirmar que nenhum worker executa o run, o
operador pode remover a branch manualmente.

`maxAttempts` e `maxIterations` continuam aceitos em workflows antigos, mas não são budgets de
execução. A lista automática de candidatos continua finita; loops de qualidade terminam por
aprovação, cancelamento, erro irrecuperável ou emergency ceiling. Retry directives antigos sem
campos de auditoria continuam legíveis; requests novos de retry exigem todos os campos acima.

Antes do upgrade, pare os workers e faça snapshot de todo `DATA_DIR`, incluindo os workspaces Git.
Não misture versões. Para rollback, preserve externamente qualquer `draft/<runId>` necessário,
restaure o snapshot pré-upgrade e só então inicie a versão antiga. Um rollback somente de código
não é suportado porque schemas antigos estritos não aceitam `run.execution`. ADR 0016 registra a
decisão e os limites.

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

### Feedback humano e export de auditoria

Novas decisões aceitam um `ActorRef`; clientes antigos que enviam somente `decidedBy` continuam
funcionando e são normalizados para um ator `user`. Em `request-changes`, o comentário é redigido
antes da persistência e a revisão exata do feedback (`name`, `revision`, `sha256`) acompanha o
retry e o prompt de reparo.

Use `GET /runs/:runId/audit` para exportar a sequência determinística de pedidos, decisões e
feedback. Para reproduzir um reparo, confira a referência `feedbackArtifact` do run/attempt e leia
a revisão correspondente no artifact store; não use automaticamente a revisão mais recente.

Não há backfill: o leitor novo aceita decisões antigas sem `actor`. Essa compatibilidade é somente
new-reader/old-data: schemas estritos antigos não leem registros novos com `actor` ou
`feedbackArtifact`. Antes do upgrade, faça snapshot de `DATA_DIR`. Para downgrade, pare todos os
workers, restaure o snapshot pré-upgrade de `DATA_DIR` e só então inicie o binário antigo. Nunca
altere somente o código nem misture workers antigos e novos no mesmo diretório. Detalhes no ADR 0015.

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
