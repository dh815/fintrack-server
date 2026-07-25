const admin = require('firebase-admin');
const crypto = require('crypto');

// Mesmo algoritmo usado no resto do servidor (reset.js) e no cliente
function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha, 'utf8').digest('hex');
}

// Contas bem antigas guardavam a senha só em base64 (não é hash de verdade,
// mas precisamos continuar aceitando login dessas contas legadas)
function legadoBase64(senha) {
  return Buffer.from(senha, 'utf8').toString('base64');
}

function senhaConfere(senhaDigitada, hashArmazenado) {
  return hashArmazenado === hashSenha(senhaDigitada) || hashArmazenado === legadoBase64(senhaDigitada);
}

// Gera um token de login real do Firebase Authentication, vinculado
// exatamente ao username (uid = username). É isso que permite travar
// as regras do banco por dono de verdade, sem depender de login anônimo.
async function criarTokenLogin(username) {
  return admin.auth().createCustomToken(username);
}

module.exports = { hashSenha, senhaConfere, criarTokenLogin };
