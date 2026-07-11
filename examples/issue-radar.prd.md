# PRD: Issue Radar

## Problema

Equipes pequenas perdem bugs e decisões porque feedback chega por chat, reunião, e-mail e comentários de código. O resultado é trabalho duplicado, prioridades conflitantes e itens importantes esquecidos.

## Usuários

Engenheiros e product managers em equipes de 3 a 20 pessoas.

## Objetivo da primeira versão

Criar uma aplicação web local que permita registrar, organizar e concluir issues com uma visão rápida do estado do projeto.

## Funcionalidades

- Criar projetos.
- Criar issue com título, descrição, prioridade e status.
- Editar os campos de uma issue.
- Concluir e reabrir uma issue.
- Filtrar por status e prioridade.
- Exibir contagens por status em um dashboard simples.
- Persistir dados entre reinicializações.
- Exibir estados de loading, vazio e erro.

## Regras

- Título é obrigatório e possui no máximo 140 caracteres.
- Prioridades: baixa, média, alta e crítica.
- Status: aberta, em andamento e concluída.
- Uma issue concluída registra `completedAt`.
- Reabrir limpa `completedAt`.

## Critérios de aceite

- O usuário consegue criar um projeto e entrar nele.
- O usuário consegue criar, editar, concluir e reabrir uma issue.
- Filtros podem ser combinados.
- Dados permanecem disponíveis após reiniciar a aplicação.
- Entradas inválidas retornam mensagens específicas.
- O dashboard reflete imediatamente as alterações.
- Fluxos principais têm testes automatizados.
- `npm run typecheck`, `npm test` e `npm run build` passam.

## Requisitos não funcionais

- TypeScript com modo estrito.
- Interface responsiva para desktop e celular.
- Operações locais devem responder em menos de 300 ms em condições normais.
- Dados não devem sair da máquina.
- Erros inesperados devem ser registrados sem expor conteúdo sensível na UI.

## Fora de escopo

- Login social.
- Billing.
- Colaboração em tempo real.
- Notificações.
- Integrações externas.
- Aplicativo móvel nativo.
- Anexos.

## Restrições

- Priorizar uma solução simples que rode com um único comando.
- Evitar microserviços, broker externo e infraestrutura desnecessária.
- Registrar decisões arquiteturais relevantes e alternativas rejeitadas.
