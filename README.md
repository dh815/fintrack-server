# Fintrack Server

Servidor Node.js para integração com Mercado Pago e WhatsApp Bot.

## Deploy no Railway

1. Crie um novo projeto no Railway
2. Conecte este repositório
3. Configure as variáveis de ambiente (veja abaixo)

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

### Mercado Pago
- `MP_ACCESS_TOKEN` — Acesse mercadopago.com.br → Seu negócio → Credenciais

### Firebase Admin
Acesse console.firebase.google.com → Configurações → Contas de serviço → Gerar nova chave privada
- `FIREBASE_PROJECT_ID` = fintrack-b1b89
- `FIREBASE_DATABASE_URL` = https://fintrack-b1b89-default-rtdb.firebaseio.com
- `FIREBASE_CLIENT_EMAIL` — do JSON baixado
- `FIREBASE_PRIVATE_KEY` — do JSON baixado

### App
- `APP_URL` — URL do Railway após deploy (ex: https://fintrack-server.railway.app)
- `FINTRACK_URL` = https://dh815.github.io/fintrack
- `ADMIN_TOKEN` — senha para acessar /admin/usuarios (escolha qualquer string)

### WhatsApp (opcional por enquanto)
- `ZAPI_INSTANCE` — ID da instância Z-API
- `ZAPI_TOKEN` — Token da instância Z-API
- `CLAUDE_API_KEY` — Chave da API Claude (mesma do app)

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | / | Status do servidor |
| GET | /health | Health check Railway |
| POST | /pagamento/criar | Cria link de pagamento MP |
| POST | /webhook/mercadopago | Recebe notificações MP |
| POST | /webhook/whatsapp | Recebe mensagens WhatsApp |
| GET | /admin/usuarios | Lista usuários (requer token) |

## Fluxo de pagamento

1. App chama `POST /pagamento/criar` com `{username}`
2. Servidor cria preferência no Mercado Pago
3. Retorna `init_point` (URL de pagamento)
4. Usuário paga
5. MP chama `POST /webhook/mercadopago`
6. Servidor verifica pagamento e atualiza Firebase
7. Usuário vira Pro automaticamente
