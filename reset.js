const axios = require('axios');
const crypto = require('crypto');

// Gera um token aleatório seguro para o link de redefinição de senha
function gerarToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Mesmo algoritmo (SHA-256) que o cliente usa via Web Crypto, pra manter compatibilidade
function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha, 'utf8').digest('hex');
}

// Envia o e-mail de recuperação de senha via Brevo
async function enviarEmailReset(email, username, token) {
  const link = `${process.env.FINTRACK_URL}?reset=${token}&u=${encodeURIComponent(username)}`;

  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender: { email: process.env.BREVO_FROM, name: 'Fintrack' },
      to: [{ email }],
      subject: 'Redefinição de senha — Fintrack',
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
          <h2 style="color:#00C896;">Fintrack</h2>
          <p>Recebemos uma solicitação para redefinir a senha da conta <b>${username}</b>.</p>
          <p>Clique no botão abaixo para escolher uma nova senha. Este link expira em 1 hora.</p>
          <p style="margin: 28px 0;">
            <a href="${link}" style="background:#00C896;color:#07090F;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Redefinir senha</a>
          </p>
          <p style="font-size:12px;color:#888;">Se você não solicitou isso, pode ignorar este e-mail com segurança — sua senha continua a mesma.</p>
        </div>
      `,
    },
    {
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );
}

module.exports = { gerarToken, hashSenha, enviarEmailReset };
