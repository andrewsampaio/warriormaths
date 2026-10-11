# WarriorMaths — servidor

Servidor do jogo: guarda o progresso, o saldo de presas, as compras e o inventário no PostgreSQL, gerencia as salas multiplayer e gera os tokens de voz do LiveKit. Também serve o jogo (`/`) e o painel das famílias (`/familia.html`).

## Deploy no Coolify

1. Suba esta pasta para um repositório Git (privado).
2. No Coolify: **New Resource → Docker Compose** e aponte para o repositório. Ele usa o `docker-compose.yml`, que sobe a API e um PostgreSQL 16 com volume persistente.
3. Na aba **Environment**, preencha as variáveis de `.env.example`:
   - `POSTGRES_PASSWORD`: uma senha longa.
   - `JWT_SECRET`: uma sequência aleatória de pelo menos 32 caracteres (`openssl rand -hex 32`).
   - `LIVEKIT_URL`: a URL `wss://` do seu LiveKit.
   - `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`: as chaves do seu LiveKit.
4. Em **Domains**, aponte o serviço `app` (porta 3000) para o domínio, por exemplo `https://gatos.flowpros.es`. O HTTPS é obrigatório: sem ele o celular não libera o microfone.
5. Deploy. As tabelas são criadas sozinhas na primeira vez.

## Primeiros passos

1. Abra `https://seu-dominio/familia.html`, crie a conta da família (correio + senha + consentimento) e crie uma jogadora com um apodo e um PIN.
2. Anote o **código de jogadora** (ex.: `ABCD-1234`).
3. No celular, abra `https://seu-dominio`. Se ela já jogava, vá em **Menú → Cuenta → Entrar con mi código** (em inglês: **Menu → Account → Sign in with my code**): a partida do celular é enviada para o servidor na primeira vez.
4. As famílias das amigas fazem o mesmo, cada uma com a sua conta.

## Jogar com amigas

**Menú → Cuenta → Jugar con amigas → Crear sala** gera um código (ex.: `K7M-2QX`). As amigas entram em **Entrar en la sala** e a anfitriã aceita cada uma. Todas se veem no mesmo território, falam por voz (botão 🎙) e podem mandar frases prontas (💬). A anfitriã pode expulsar alguém. Máximo de 8 por sala; a voz não é gravada.

## Idioma

O jogo tem espanhol e inglês: **Menú → Idioma / Language** (ou os botões no cartão inicial). A escolha fica salva na partida e acompanha a conta. As mensagens de erro do servidor também saem no idioma do jogo (cabeçalho `x-lang`). O painel das famílias continua em espanhol.

## O que fica no banco

| Tabela | Conteúdo |
|---|---|
| `families` | correio, senha (hash bcrypt), data do consentimento |
| `players` | apodo, código, PIN (hash), última vez |
| `progress` | estado completo do jogo (`jsonb`), versão, capítulo, honor, presas |
| `inventory` | objetos comprados, quantidades dos itens de ajuda, o que está equipado |
| `ledger` | histórico de presas: importação, ganhos, perdas e compras |

Regras: o servidor é a autoridade das **compras** (preço, saldo e "já tem"); o que se ganha jogando chega pela sincronização, com um teto por envio (`MAX_EARN_PER_SYNC`). Se dois celulares salvarem ao mesmo tempo, vale a versão mais recente.

**Privacidade:** não guardamos nome real, idade nem foto. Apagar uma jogadora ou a família inteira no painel apaga tudo dela (progresso, inventário e histórico).

## Atualizar os preços

Se os preços mudarem no jogo, regenere o catálogo do servidor a partir do `state.js` do jogo:

```bash
node tools/gen-catalog.js caminho/para/state.js
```

## Rodar localmente

```bash
npm install
DATABASE_URL=postgres://gatos:gatos@localhost:5432/gatos JWT_SECRET=$(openssl rand -hex 32) \
LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... npm start
```
