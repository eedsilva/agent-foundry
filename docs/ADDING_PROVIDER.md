# Adicionar um executor

Um executor adapta `AgentExecutionRequest` para uma ferramenta concreta e devolve `AgentExecutionResult`.

## 1. Implemente `AgentExecutor`

Para uma CLI, prefira estender `BaseCliExecutor`:

```ts
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { BaseCliExecutor, type CliInvocation } from './base-cli-executor.js';

export class ExampleCliExecutor extends BaseCliExecutor {
  readonly provider = 'example' as const;
  protected readonly command = 'example-cli';

  protected async invocation(request: AgentExecutionRequest): Promise<CliInvocation> {
    return {
      command: this.command,
      args: ['run', '--model', request.model, '--json', request.prompt],
    };
  }
}
```

A implementação precisa definir:

- diretório de trabalho;
- timeout;
- limite de output;
- modo read-only ou mutável;
- structured output ou estratégia de parsing;
- como o prompt é enviado;
- como a resposta final é encontrada;
- health check.

## 2. Adicione o provider aos contratos

Atualize `ProviderSchema` e qualquer enum derivado. Isso quebra deliberadamente o compilador em locais que precisam conhecer o novo valor.

## 3. Registre no composition root

Inclua o executor em `StaticExecutorRegistry` dentro de `packages/composition/src/runtime.ts`.

## 4. Adicione modelos ao catálogo

Inclua pelo menos um modelo habilitado com priors conservadores. Não copie notas de marketing como se fossem medição local.

## 5. Teste o contrato

Testes mínimos:

- argumentos para tarefa read-only;
- argumentos para tarefa mutável;
- modelo vazio versus explícito;
- parse de resposta direta e envelopada;
- usage simples e JSONL;
- exit code diferente de zero;
- timeout;
- output acima do limite;
- health indisponível.

## 6. Verifique segurança

Perguntas obrigatórias:

- A CLI pode acessar fora do workspace?
- O modo não interativo pede confirmação e trava?
- Há uma flag de bypass perigosa sendo usada?
- O comando recebe prompt por argv, stdin ou arquivo?
- O prompt pode aparecer em `ps` ou logs?
- A CLI herda segredos do ambiente?
- O sandbox permite rede?
- Existe forma de limitar ferramentas?

Uma interface comum não elimina diferenças de segurança. Ela apenas cria um lugar explícito para tratá-las.
