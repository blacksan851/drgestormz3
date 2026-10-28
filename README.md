quer﻿# DR Gestor Payment

## O que ja vem pronto

- Login administrativo para abrir o painel
- Checkout publico para clientes
- Integracao PaySuite no backend
- Persistencia local, MySQL/MariaDB ou Supabase
- Estrutura pronta para Hostinger com banco externo

## Credenciais iniciais do painel

Se ainda nao alterou as variaveis de ambiente, o acesso inicial e:

- Login: `admin`
- Email alternativo: `admin@drgestor.local`
- Senha: `Admin@12345`

Altere estas credenciais antes de usar em producao.

## Executar localmente

1. Instale as dependencias com `npm install`
2. Ajuste as variaveis em `.env`
3. Inicie a API com `npm run api`
4. Inicie o frontend com `npm run dev`
5. Abra `http://127.0.0.1:3000/login`

## Persistencia

O sistema suporta tres modos de persistencia:

- `STORAGE_DRIVER="file"`: guarda os dados em `server-data/store.json`
- `STORAGE_DRIVER="mysql"`: guarda os dados numa base MySQL/MariaDB
- `STORAGE_DRIVER="supabase"`: guarda os dados no Supabase via API oficial

## Configurar Supabase

1. Crie um projeto no Supabase.
2. Abra o SQL Editor e execute o ficheiro `SUPABASE-SETUP.sql`.
3. Copie a `Project URL` para `SUPABASE_URL`.
4. Copie a `service_role key` para `SUPABASE_SERVICE_ROLE_KEY`.
5. Defina `STORAGE_DRIVER="supabase"`.

Variaveis usadas no modo Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SCHEMA` (normalmente `public`)
- `SUPABASE_TABLE` (opcional)

## Configurar MySQL/Hostinger

Se preferir manter MySQL, preencha estas variaveis:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_TABLE` (opcional)
- `DB_SSL` (`true` se o servidor exigir SSL)

## Ficheiros de apoio

- `.env.hostinger.example`: modelo de ambiente para producao
- `SUPABASE-SETUP.sql`: cria a tabela usada pelo sistema no Supabase
- `HOSTINGER-NODE-DEPLOY.txt`: guia rapido de publicacao
