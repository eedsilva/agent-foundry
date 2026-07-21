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

## Versionamento de projeto

`ProjectVersion` é um ledger imutável sobre o histórico git do workspace: cada versão aponta para um commit, artifacts (última revisão por nome) e, quando aplicável, a run/step/attempt que a produziu. Hoje uma versão `kind: 'run'` é registrada automaticamente após cada step mutável commitar (`workflow-orchestrator.ts`); quando o domínio de Conversation (issue #36) chegar, versões passam a ser registradas por Operation aprovada em vez de por step — a mesma API de registro, sem mudança de forma.

```bash
GET  /projects/:projectId/versions
GET  /projects/:projectId/versions/compare?from=<versionId>&to=<versionId>
POST /projects/:projectId/versions/:versionId/revert
POST /projects/:projectId/versions/:versionId/branch
POST /projects/:projectId/versions/:versionId/protect
```

`compare` retorna um `git diff` bruto entre os commits das duas versões; não há parser semântico de schema/config, a UI apenas colore linhas por prefixo `+`/`-`. `revert` nunca reescreve nem apaga a versão original: restaura a árvore do commit alvo e cria um novo commit e uma nova versão (`kind: 'revert'`) apontando para o `parentVersionId`. `branch` cria uma branch git independente a partir do commit da versão de origem sem mover HEAD nem a branch atual, e também registra uma nova versão (`kind: 'branch'`). `protect` alterna a flag `protected` de uma versão; ela é a única mutação permitida em um registro já criado — todo outro campo é imutável e rejeitado por `FileProjectVersionRepository.update`.

Não existe hoje nenhum job de limpeza/retenção no codebase — `protected` fica gravado para um job futuro consultar, mas nada ainda apaga versões antigas. Sequências (`sequence`) assumem um único escritor por projeto, a mesma premissa já usada por `StepAttempt.sequence`; não há arbitragem de reserva para múltiplos escritores concorrentes no mesmo projeto.

### Verificação no navegador

O quality loop `browser-verification` cria `browser-test.plan` (um `AgentArtifact` versionado) e
executa-o em Chromium headless através da porta `BrowserVerifier`; o orquestrador não importa
Playwright. Instale o browser localmente antes da evidência:

```bash
npx playwright install chromium
```

O job `test` de CI executa `npx playwright install --with-deps chromium` depois de `npm ci` e antes
de `npm test`. Não substitua por instalação de todos os browsers: o runtime só usa Chromium.

O plano aceita no máximo 100 passos, começa com `goto` e usa somente paths relativos, locators
semânticos e ações/assertions declarativas. Cada ação, assertion e espera de requests tem 10 s; a
execução inteira tem 60 s. A sessão de preview é sempre parada ao terminar, falhar, expirar o timeout
ou ser cancelada. `console.error`, exceção não capturada, request falho, HTTP >= 400 e bloqueio de
política entram como observações; qualquer um torna o relatório não aprovado. Há no máximo 100
observações, para manter o JSON de diagnóstico limitado.

O mesmo validador de path é usado pelo contrato e pelo executor. Ele rejeita traversal literal ou
codificado, network paths codificados, barra invertida, controles e percent-encoding aninhado antes
de resolver a URL; depois disso o executor ainda confirma o prefixo exato da sessão. A instrumentação
estática do executor acompanha `setTimeout` one-shot de até 1.000 ms em todas as páginas e popups,
inclusive handlers string executados nativamente pelo Chromium, e drena esses timers antes do próximo
step. `setInterval`, `requestAnimationFrame` e timers acima de 1.000 ms não são aguardados para evitar
hang em polling; erros disparados por eles podem ficar fora da atribuição determinística do step.

O JSON Schema entregue ao provider expressa o primeiro `goto`, bounds, unions, viewport e padrão de
path. IDs únicos por propriedade não são expressáveis no JSON Schema padrão: a extensão
`x-agent-foundry-runtime-validation.uniqueStepIds` aponta para a validação Zod autoritativa executada
antes do Chromium. Saída inválida do provider gera report reprovado reproduzível.

O relatório `browser-verification.report` referencia o plano por `{ name, revision, sha256 }`, inclui
a sessão de preview sem token e registra steps, duração, erro e observações. Quando falha, o reparo
recebe esse relatório e a mesma revisão de `browser-test.plan`; o rerun não gera nem troca o plano.
Screenshots e traces não são capturados neste fluxo: evidência binária é escopo da issue #33.

`browserAllowedOrigins` é opcional na policy. Sem ele, o navegador só pode usar a origem e o prefixo
exato `/preview/<sessionId>/` da sessão (incluindo WebSocket correspondente). Uma origem adicional
deve ser HTTP(S) e idêntica a `URL.origin`; paths, query, fragmentos e wildcards são inválidos. Isso
não relaxa o proxy: o preview continua acessível somente em loopback conforme ADR 0017.

Migração é somente de leitura: policies sem `browserAllowedOrigins` e steps sem
`browserTestPlanArtifact` continuam como antes, usando verificação de workspace. Para rollback,
remova o nó `browser-verification` do workflow e o wiring de runtime/coordinator; a qualidade de
workspace continua. Preserve reports e attempts existentes para investigação, sem backfill.

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

Os três JSONLs são append-only no modelo, mas cada write publica o arquivo completo por temp file sincronizado + rename atômico enquanto segura o lock da conversa. Assim, depois de crash, o path live contém o estado completo anterior ou o novo; arquivos `.tmp` órfãos não participam da reconstrução.

Cada mensagem persistida recebe um `sequence` positivo. `GET /projects/:projectId/conversation?cursor=<sequence>&limit=<n>` usa um cursor não negativo e exclusivo: `cursor=0` começa na primeira mensagem, e os demais valores retornam mensagens depois do sequence informado. O default é `cursor=0`; `limit` tem default `50` e máximo `200`. `nextCursor` é o último sequence da página quando há mais mensagens. O response também inclui toda a metadata de attachments e operações da conversa.

`GET /projects/:projectId/conversation/stream` emite mensagens persistidas com `id: <sequence>`. Para reconnect, envie `?cursor=<sequence>` ou `Last-Event-ID`; query vence o header. Ambos são cursores não negativos e exclusivos, e `0` começa na primeira mensagem. O servidor lê até 500 mensagens por poll de um segundo e envia heartbeat a cada 15 segundos. Como o cursor é exclusivo, reconnect após o último id recebido não repete esse frame.

Crie metadata em `POST /projects/:projectId/conversation/attachments` antes de referenciá-la em uma mensagem. O `mediaType` aceita no máximo 127 caracteres, deve ser bare `type/subtype` e é normalizado para minúsculas, por exemplo `IMAGE/PNG` vira `image/png`; valores inválidos, como `text/plain; charset=utf-8`, retornam `400`. O slice não recebe nem serve blobs e não verifica que SHA-256/tamanho correspondem a um arquivo. Blob storage e UI ficam em #43.

Ao criar uma operação em `POST /projects/:projectId/conversation/messages/:messageId/operations`, envie `idempotencyKey` com exatamente 64 caracteres hexadecimais minúsculos (`0-9`, `a-f`); formato inválido retorna `400`. Reuse a mesma chave somente para o mesmo input. Retry idêntico retorna a operação original; mudança de message, kind ou links com a mesma chave retorna `409`. O endpoint apenas persiste a operação tipada: classificação fica em #38 e execução/lifecycle em #39.

Use `GET /projects/:projectId/export` para obter schema v1 com project e um snapshot coerente de conversation, messages, attachments e operations lido sob o lock da conversa. Um writer concorrente fica inteiro antes ou depois do snapshot; o export não inclui uma operação sem sua mensagem já persistida. Para projetos legados sem diretório `conversation/`, o snapshot vazio continua sem criar storage. Texto/data de mensagem e nome de attachment já foram redigidos no write, mas trate o export e todo `DATA_DIR` como sensíveis.

Não há migração. Ausência real de `conversation/` (`ENOENT`) ativa a derivação legacy; corrupção de path, como um parent que virou arquivo (`ENOTDIR`), falha o read/export em vez de produzir snapshot vazio. O `id` e `projectId` de `conversation.json` também precisam corresponder ao diretório do projeto. Para rollback, pare API e outros writers do `DATA_DIR` e faça snapshot. O binário antigo ignora a árvore aditiva `conversation/`; ela pode permanecer sem uso para um upgrade posterior. Restaure o snapshot pré-upgrade somente quando precisar remover os novos records, e não misture writers antigos e novos.

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

Três trilhas locais já existiam antes de qualquer SDK de tracing:

- `events.jsonl` para linha do tempo;
- `DATA_DIR/runs/` para estado consultável e versionado de run, step e attempt;
- artefatos `run-*` para contexto, harness e diagnósticos detalhados de cada attempt;
- `metrics/models.json` para roteamento.

Por cima delas, a API e o worker instrumentam OpenTelemetry (traces + métricas) e correlacionam
logs estruturados com o trace ativo. Sem configuração, tudo isso é inerte: nenhum SDK é registrado,
`withSpan`/os helpers de métrica seguem sendo os no-ops padrão de `@opentelemetry/api`, e o único
custo é o overhead desprezível dessas chamadas no-op.

### Habilitar

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=agent-foundry-api
OTEL_TRACES_SAMPLER_RATIO=1
OTEL_SLOW_RUN_THRESHOLD_MS=60000
```

`OTEL_EXPORTER_OTLP_ENDPOINT` não configurado (o padrão) é o interruptor: nada é registrado. Ao
definir, `apps/api` e `apps/worker` cada um chama `startTelemetry` no boot com seu próprio
`OTEL_SERVICE_NAME` (`agent-foundry-api` / `agent-foundry-worker` por padrão) e fazem `await
telemetry.shutdown()` no handler de `SIGINT`/`SIGTERM`, antes de fechar o resto — traces e métricas
em voo são drenados para o coletor antes do processo sair. Traces vão para
`<endpoint>/v1/traces`, métricas para `<endpoint>/v1/metrics`, ambos no formato OTLP/HTTP. Não há
coletor embutido — aponte para qualquer backend compatível (Collector, Jaeger, Tempo, etc.).

A instrumentação é manual, não `NodeSDK`/auto-instrumentation: só os pontos listados abaixo emitem
spans, e nada de HTTP/fs/etc. de terceiros é interceptado automaticamente.

### Árvore de spans

Uma requisição encadeia `foundry.request` → `foundry.job` → `foundry.run` → `foundry.step` →
`foundry.attempt` → `foundry.cli`, com `foundry.operation` e `foundry.preview` como raízes
paralelas para chat/build e preview. O contexto atravessa a fila: `job.traceContext` (serializado
via `serializeTraceContext()` quando o job é enfileirado) é extraído pelo worker
(`withExtractedContext`) antes de abrir `foundry.job`, então job e request compartilham `traceId`.

| Span                | Onde                                                                 | Atributos principais                                                                                                           |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `foundry.request`   | `apps/api/src/app.ts` (hook `onRequest`/`onResponse` no app inteiro) | `http.method`, `http.route`, `http.status_code`                                                                                |
| `foundry.job`       | `worker-loop.ts`, ao tirar um job da fila                            | `foundry.job.id`, `foundry.job.type`, `foundry.job.attempts`, `foundry.queue.wait_ms`                                          |
| `foundry.run`       | `workflow-orchestrator.ts`, por execução de workflow                 | `foundry.project.id`, `foundry.run.id`, `foundry.workflow.id`, `foundry.run.duration_ms` (ao terminar)                         |
| `foundry.step`      | `workflow-orchestrator.ts`, por node do workflow                     | `foundry.step.node_id`, `foundry.step.id`, `foundry.step.type`                                                                 |
| `foundry.attempt`   | `workflow-orchestrator.ts`, por tentativa de step                    | `foundry.attempt.id`, `foundry.attempt.sequence`, `foundry.model.id`, `foundry.provider`, `foundry.force_sample` (condicional) |
| `foundry.cli`       | `base-cli-executor.ts`, ao invocar a CLI do provider                 | `foundry.provider`, `foundry.cli.command` — nunca args/prompt, que nunca chegam a um span                                      |
| `foundry.operation` | `conversation-operation-runner.ts`, por operação de chat/build       | `foundry.operation.id`, `foundry.operation.kind`, `foundry.force_sample` (em falha)                                            |
| `foundry.preview`   | `preview-service.ts`, ao iniciar uma sessão de preview               | `foundry.preview.session_id`                                                                                                   |

Rotas SSE (sufixo `/stream`) não abrem `foundry.request`: elas fazem `reply.hijack()` e o Fastify
nunca dispara `onResponse` numa reply hijacked, então um span aberto ali vazaria (nunca terminaria).
Todas as outras rotas — incluindo as de blob (`/blobs/*`, `/projects/:id/artifacts/:name/blob-url`)
— passam pelo hook normalmente porque não são hijacked. Um listener em `request.raw.on('close', …)`
fecha o span também quando o cliente desconecta antes da resposta terminar.

### Métricas

| Métrica                           | Tipo      | Descrição                                                  |
| --------------------------------- | --------- | ---------------------------------------------------------- |
| `foundry.run.duration_ms`         | histogram | duração do run, com atributo `status`                      |
| `foundry.step.retries`            | counter   | reparos/retries de step                                    |
| `foundry.queue.wait_ms`           | histogram | tempo entre enfileirar e o worker pegar o job              |
| `foundry.tokens.input`            | histogram | tokens de entrada por attempt, com `foundry.model.id`      |
| `foundry.tokens.output`           | histogram | tokens de saída por attempt, com `foundry.model.id`        |
| `foundry.preview.active_sessions` | gauge     | sessões de preview ativas (proxy de utilização do sandbox) |

Exportadas via `PeriodicExportingMetricReader` a cada 15s para `<endpoint>/v1/metrics`.

### Correlação de logs

Ambos os processos usam pino com `mixin: () => currentTraceIds()`: todo log emitido enquanto há um
span ativo carrega `traceId`/`spanId` automaticamente, sem passá-los explicitamente em cada
chamada. Sem telemetria habilitada, `currentTraceIds()` devolve `{}` e o mixin não adiciona nada.

### Redaction

Todo exporter de trace passa por `RedactingSpanExporter`, que aplica `redactString` (o mesmo
filtro usado em `events.jsonl` e nos artefatos) em atributos, na mensagem de status e em nome e
atributos de cada evento — inclusive `exception.message`/`exception.stacktrace` de
`span.recordException`, que senão escapariam da redação normal de atributos. É o único ponto de
filtro: nenhum outro exporter/processor de trace é registrado sem passar por ele. `foundry.cli`
carrega apenas o nome do comando, nunca args ou stdout/stdin — prompts não chegam a um span.

### Sampling

`OTEL_TRACES_SAMPLER_RATIO` controla a fração de traces amostrados por `TraceIdRatioBased` na raiz
(`ParentBasedSampler`), mas dois mecanismos preservam sinal fora dessa fração:

1. **Head**: um span cuja fábrica marcou `foundry.force_sample: true` na criação (ex.: retries de
   fallback, tentativas além da primeira) é sempre `RECORD_AND_SAMPLED`, ratio à parte.
2. **Export-time (tail)**: `KeepErrorsSampler` nunca devolve `NOT_RECORD` — rebaixa para `RECORD`
   qualquer span que o ratio teria descartado, mantendo seus dados vivos até `onEnd`.
   `TailSpanProcessor` decide ali, com status/atributos/duração já conhecidos, se exporta mesmo
   assim: status `ERROR`, `foundry.force_sample` setado reativamente no catch (ex.: falha de
   operação/run, quando o resultado só é conhecido depois do span ter começado), ou
   `foundry.run.duration_ms` acima de `OTEL_SLOW_RUN_THRESHOLD_MS` (span marcado `foundry.slow` por
   `RedactingSpanExporter`). Um span mantido assim é exportado uma vez, direto pelo mesmo exporter
   (logo, também redigido).

`ponytail`: `TailSpanProcessor` mantém cada span _recorded_ em memória até terminar — aceitável na
escala atual. Se isso deixar de ser verdade, o upgrade é um tail sampler do lado do coletor
(spans sempre exportados pelo SDK, retenção decidida a jusante) — recomendado de qualquer forma
para operações que já rodam um Collector: ele pode reter traces lentos/com erro observando a árvore
inteira, sem o SDK precisar manter nada vivo.

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

`PERSISTENCE_MODE` alterna projects, runs, steps, attempts, approval requests/decisions, events, step events, conversations e artifacts entre disco (`file`, padrão) e Postgres. Queue, metrics, quality observations, previews, model overrides, project versions, workflows, policies e workspaces continuam em `DATA_DIR` nos dois modos — ADR 0026 registra a decisão e o que ainda falta para uma data plane de produção completa.

### Supabase Postgres (opção hospedada padrão)

Supabase é o backend hospedado padrão para banco e storage do agent-foundry. Para usar o Postgres de um projeto Supabase como `DATABASE_URL`: no dashboard, abra Connect → connection string e copie a URI — prefira a session pooler connection string (porta 5432, `...pooler.supabase.com`) para processos de longa duração como a API e o worker; a conexão direta (porta 5432, host `db.[project-ref].supabase.co`) também funciona, mas é mais sujeita a limite de conexões simultâneas em plano free. Em `...pooler.supabase.com`, a porta 6543 é o transaction pooler e não deve ser usada para `npm run db:migrate`, cujo `pg_advisory_lock` é session-scoped e quebra sob o transaction pooler; os adapters de runtime (API e worker) já são xact-lock/pooler-safe e funcionam com qualquer uma das portas. Essa URL funciona sem alterações com `PERSISTENCE_MODE=postgres` e `npm run db:migrate` — nenhuma dependência de `supabase-js` é necessária (ver ADR 0026). Para desenvolvimento local sem depender da nuvem, `supabase start` (Supabase CLI) sobe um Postgres local equivalente em `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Para blobs (screenshots, traces, bundles), ver a seção de Supabase Storage adicionada pelo PR do #54.

### Habilitar

```env
PERSISTENCE_MODE=postgres
DATABASE_URL=postgres://foundry:foundry@localhost:5432/foundry
```

`DATABASE_URL` é obrigatório quando `PERSISTENCE_MODE=postgres`; sem ele, `loadRuntimeConfig` falha no boot com `PERSISTENCE_MODE=postgres requires DATABASE_URL` em vez de silenciosamente cair para disco. O serviço `postgres` do `docker-compose.yml` sobe um Postgres 17 local (`foundry`/`foundry`/`foundry`) com healthcheck; as linhas `PERSISTENCE_MODE`/`DATABASE_URL` dos serviços `api` e `worker` estão comentadas porque o padrão de deploy continua `file`. Para usar Supabase em vez do Postgres local do Compose, substitua `DATABASE_URL` pela connection string do Supabase descrita acima.

### Migrar

```bash
DATABASE_URL=postgres://foundry:foundry@localhost:5432/foundry npm run db:migrate
```

Roda `migrateUp` (migrations SQL embarcadas, seriadas por `pg_advisory_lock`) e imprime as versões aplicadas ou `schema up to date`. Rode antes do primeiro boot em modo postgres e após qualquer upgrade que adicione migration nova. A API e o worker nunca migram sozinhos: `assertSchemaCurrent` roda uma vez no boot e falha fechado, apontando para este comando, se a versão do schema estiver atrás do binário.

### Rollback

Pare API e worker, volte `PERSISTENCE_MODE` para `file` (ou remova a variável) e reinicie. Dados gravados em modo postgres não são sincronizados de volta para `DATA_DIR`: o rollback restaura o comportamento em disco a partir do estado que já existia lá, não migra o conteúdo do Postgres. Para voltar a operar sobre os dados gravados em Postgres, mantenha `PERSISTENCE_MODE=postgres` e trate o banco como a fonte de verdade — não alterne os dois modos como se fossem réplicas do mesmo estado.

Blobs de artifact (screenshots, traces, bundles) hoje vivem em `bytea` dentro do Postgres — isso é um teto conhecido de tamanho/memória; migrar `PostgresArtifactStore` para o `BlobStore` de object storage (ver seção seguinte, #54) fica para uma PR posterior (#59/#232). Até lá, evite `PERSISTENCE_MODE=postgres` em projetos que gerem evidência binária grande. Em modo postgres, blobs ficam em `bytea` e as URLs assinadas de download (`/blob-url`, GC de blobs) aplicam-se ao modo `file`/`s3`, não ao Postgres: a rota `/blob-url` assina uma chave que nunca foi escrita no `BlobStore` configurado e o GC (`sweepUnreferencedBlobs`) não enxerga nada para varrer — nenhuma das duas quebra, mas o fetch da URL assinada retorna 404 para artifacts gravados em modo postgres, uma degradação silenciosa conhecida e rastreada em #232/#59.

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

## Armazenamento de blobs (object storage)

Bytes de artifact (o `content` binário/grande, não o metadata) passam por um port `BlobStore` com dois adapters intercambiáveis: `FsBlobStore` (padrão, bytes sob `DATA_DIR`) e `S3BlobStore` (qualquer endpoint compatível com S3, incluindo MinIO). `FileArtifactStore` delega toda leitura/escrita de bytes ao `BlobStore` configurado; a chave do objeto é **derivada e imutável** — `blobKeyFor(projectId, name, revision)` produz `projects/<projectId>/artifacts/<name>/<revision:6 dígitos>` — nunca gravada em metadata separado. Ver ADR 0025 para a decisão completa (port, keymap, split HMAC vs. presigned, GC com grace period).

### Modos e variáveis

| Variável               | Padrão                                                  | Função                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOB_STORE_MODE`      | `fs`                                                    | `fs` ou `s3`                                                                                                                                                                                      |
| `BLOB_SIGNING_SECRET`  | derivado                                                | segredo HMAC para URLs assinadas em modo `fs` (ver abaixo)                                                                                                                                        |
| `BLOB_GC_GRACE_MS`     | `86400000`                                              | idade mínima (ms) de um blob não referenciado antes do GC apagar                                                                                                                                  |
| `S3_ENDPOINT`          | —                                                       | obrigatório em modo `s3`                                                                                                                                                                          |
| `S3_REGION`            | —                                                       | obrigatório em modo `s3`                                                                                                                                                                          |
| `S3_BUCKET`            | —                                                       | obrigatório em modo `s3`                                                                                                                                                                          |
| `S3_ACCESS_KEY_ID`     | —                                                       | obrigatório em modo `s3`                                                                                                                                                                          |
| `S3_SECRET_ACCESS_KEY` | —                                                       | obrigatório em modo `s3`                                                                                                                                                                          |
| `S3_FORCE_PATH_STYLE`  | `true` se `S3_ENDPOINT` estiver definido, senão `false` | necessário para MinIO, Supabase Storage e outros endpoints path-style (endpoint customizado ⇒ não-AWS ⇒ path-style; defina explicitamente `false` para sobrepor num S3 real virtual-hosted-style) |

Em modo `s3`, os cinco vars `S3_*` (exceto `S3_FORCE_PATH_STYLE`) são obrigatórios — a config falha ao carregar (via `superRefine`) citando cada var ausente. Em modo `fs`, se `BLOB_SIGNING_SECRET` não for definido, a API deriva um segredo por instalação na primeira vez que precisa dele: 32 bytes aleatórios em hex, gravados uma única vez em `DATA_DIR/blob-signing-secret` com permissão `0600` e reaproveitados depois (criação atômica via `wx`, então dois processos disputando um `DATA_DIR` novo convergem para o mesmo segredo — quem perde a corrida apenas lê o que o outro gravou). Defina `BLOB_SIGNING_SECRET` explicitamente para fixá-lo, por exemplo ao restaurar um `DATA_DIR` em outra máquina.

Downloads usam URL assinada curta e autorização do projeto, nos dois modos:

```bash
GET /projects/:projectId/artifacts/:name/blob-url?revision=<n>
```

Repete as mesmas checagens de projeto/artifact/`blobDeleted` da rota `/blob` existente e retorna `{ url, expiresAt }` com TTL de 300 segundos. Em modo `s3` a URL é um presigned S3 URL direto (`GetObjectCommand` + `getSignedUrl`); a API nunca proxeia os bytes. Em modo `fs` a URL aponta para uma rota própria da API:

```bash
GET /blobs/*?token=<token>
```

Registrada somente quando `BLOB_STORE_MODE=fs` (não existe em modo `s3` — as URLs presigned da S3 já servem os bytes diretamente). O token é HMAC-SHA256 (`${key}\n${expiresAtMs}`, comparação com `timingSafeEqual`); token inválido ou expirado retorna `403`, blob ausente retorna `404`.

### Supabase Storage (hospedado, recomendado)

Supabase Storage expõe a mesma API S3-compatível que `S3BlobStore` já fala — não existe (nem precisa existir) um adapter `supabase-js` separado: o protocolo S3 é um adapter só, três backends possíveis (Supabase, MinIO, AWS S3).

**Hospedado:**

1. Crie um bucket pelo dashboard do Supabase (Storage → New bucket).
2. Gere um par de chaves de acesso S3 em Project Settings → Storage → S3 Connection. Essas chaves dão acesso total a todos os buckets do projeto e ignoram RLS — trate como segredo de servidor, nunca as exponha no client.
3. Configure:
   ```
   BLOB_STORE_MODE=s3
   S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
   S3_REGION=<região exibida na página de configuração S3>
   S3_BUCKET=<bucket criado no passo 1>
   S3_ACCESS_KEY_ID=<gerado no passo 2>
   S3_SECRET_ACCESS_KEY=<gerado no passo 2>
   S3_FORCE_PATH_STYLE=true
   ```
   O formato de `S3_ENDPOINT` acima é o documentado pela Supabase para o host dedicado de storage (melhor para uploads grandes); a própria página de configuração S3 do dashboard mostra o endpoint e a região exatos do seu projeto — confira lá antes de configurar, já que isso pode variar por conta/região.

**Local (dev):** `supabase start` sobe uma stack local que já expõe a mesma API S3-compatível, sem custo de conta hospedada:

```
S3_ENDPOINT=http://127.0.0.1:54321/storage/v1/s3
S3_REGION=local
S3_FORCE_PATH_STYLE=true
```

Chaves de acesso locais saem de `supabase status -o env`.

`DATABASE_URL` para o Postgres do Supabase é configuração separada (persistência, não object storage) — ver a PR #53.

### MinIO local (quickstart, fallback neutro)

MinIO não depende de conta hospedada e é a stack que os testes automatizados deste repo sobem (via `testcontainers`, ver abaixo) — use-o para dev/CI sem Supabase, ou como referência de qualquer outro endpoint S3-compatível. `docker-compose.yml` traz um serviço `minio` comentado, junto com os envs `S3_*` correspondentes nos serviços `api`/`worker` e o volume `minio_data`. Para usar:

1. Descomente o bloco `minio:` e o volume `minio_data:` no fim do arquivo, e os blocos `S3_*`/`BLOB_STORE_MODE: s3` em `api` e `worker` (mantenha os dois em sincronia).
2. Suba com `docker compose up minio api worker`. O MinIO expõe a API em `:9000` e o console web em `:9001`; as credenciais padrão (`minioadmin`/`minioadmin`) servem só para desenvolvimento — troque antes de expor a instância.
3. Crie o bucket configurado (`S3_BUCKET`, padrão `agent-foundry`) antes do primeiro start — pelo console web em `:9001` ou via `mc mb local/agent-foundry`. A API não cria buckets; sem esse passo o primeiro write de artifact falha com `NoSuchBucket`. Feito isso, a API passa a usar `S3BlobStore` a partir do próximo start.

Para testes automatizados, `packages/persistence/src/blob/s3-testing.ts` sobe um container MinIO efêmero via `testcontainers` (mesma política skip-sem-Docker/throw-em-CI dos demais harnesses de container deste repo) — não é usado em produção, só pelos testes de `s3-blob-store.test.ts`.

### Compatibilidade de chaves (sem migração)

`FsBlobStore` resolve chaves no formato de artifact (`projects/<p>/artifacts/<n>/<revision:6>`) para o layout legado já existente em disco (`projects/<p>/artifacts/<n>/blobs/<revision>.bin`) — o mesmo arquivo que o código anterior a esta feature já escrevia. Um `DATA_DIR` existente continua servindo blobs antigos sem qualquer passo de migração. Chaves fora desse formato (uso futuro) vão para `DATA_DIR/blobs/<chave-codificada>`.

### GC com grace period

A varredura periódica da API (mesmo intervalo do reaper de artifacts, `ARTIFACT_REAP_INTERVAL_MS`) roda `sweepUnreferencedBlobs` depois de `reapExpired`: lista todas as chaves sob `projects/` no `BlobStore`, monta o conjunto de chaves referenciadas a partir do metadata de artifact de todo projeto (`storage === 'blob' && !blobDeleted`) e apaga as chaves que **não** estão nesse conjunto **e** têm `createdAt` mais antigo que `BLOB_GC_GRACE_MS` (padrão 24h). O grace period existe para cobrir a janela entre alocar a revisão, terminar o upload dos bytes e gravar o metadata — sem ele, um upload em andamento ou um processo que morreu entre essas etapas seria apagado como "órfão" antes de ter chance de se completar ou de ser reconhecido como abandonado de fato.

### Garantias de integridade

O sha256 é calculado em streaming durante a escrita (via `atomicWriteStream` em modo `fs`, via o `Transform` `meteredStream` + multipart `Upload` em modo `s3`), nunca lido de volta do conteúdo depois. Quando o chamador informa `expectedSha256`, um mismatch apaga os bytes recém-escritos e lança `BlobIntegrityError`; estourar `maxBytes` aborta o upload/escrita (`ArtifactTooLargeError`) sem deixar bytes parciais para trás.

Os dois adapters falham seguro em `stat()`: `FsBlobStore` retorna `null` quando o sidecar `<path>.meta.json` está ausente, e `S3BlobStore` retorna `null` quando o metadata `sha256` do objeto está ausente — o que cobre a janela do `put()` em modo `s3` entre o multipart `Upload` terminar e o `CopyObjectCommand` subsequente (que anexa o `sha256` como metadata) completar. Nos dois casos, uma escrita incompleta fica invisível para leitores (em vez de aparentar um blob válido com hash vazio) e naturalmente elegível para o GC descrito acima, ao invés de ser servida corrompida.

### Rollback

Reverter para `BLOB_STORE_MODE=fs` é seguro a qualquer momento: blobs já gravados em modo `fs` continuam funcionando via o keymap legado acima, sem necessidade de migração. A única perda é para blobs que foram gravados **enquanto** o modo `s3` estava ativo — esses bytes ficam no bucket S3/MinIO (não são apagados automaticamente), mas o adapter `fs` não os enxerga, então artifacts criados nessa janela ficam inacessíveis até uma migração manual dos objetos de volta para `DATA_DIR` ou até reativar o modo `s3`. Dados escritos antes ou depois da janela em modo `s3` não são afetados.

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
