const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { exec } = require('child_process');
const fs = require('fs');
const express = require('express');

// ========== SERVIDOR WEB PARA RENDER ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>🤖 Bot WhatsApp</title></head>
            <body style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>✅ BOT ATIVO</h1>
                <p>Status: Conectado</p>
                <p>📱 ${new Date().toLocaleString('pt-BR')}</p>
            </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web rodando na porta ${PORT}`);
});

// ========== DETECTAR AMBIENTE ==========
const isRender = process.env.RENDER === 'true' || process.env.IS_RENDER === 'true';
const BOT_NUMBER = process.env.BOT_NUMBER || '5531997265614'; // SEU NÚMERO AQUI

// ========== VARIÁVEIS GLOBAIS ==========
const messageLog = new Map();
const CACHE_DURATION = 120000;
const jidCache = new Map();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ========== FUNÇÕES UTILITÁRIAS ==========
function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeAnyJid(jidLike) {
    if (!jidLike) return '';
    
    const cacheKey = String(jidLike);
    if (jidCache.has(cacheKey)) return jidCache.get(cacheKey);
    
    const raw = String(jidLike);
    const user = raw.split('@')[0].split(':')[0];
    const result = user ? `${user}@s.whatsapp.net` : '';
    
    if (jidCache.size > 100) {
        const firstKey = jidCache.keys().next().value;
        jidCache.delete(firstKey);
    }
    jidCache.set(cacheKey, result);
    
    return result;
}

function toJid(number) {
    const clean = normalizeNumber(number);
    return clean ? `${clean}@s.whatsapp.net` : '';
}

function getMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    return '';
}

function getQuotedMessage(message) {
    return (
        message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        message?.imageMessage?.contextInfo?.quotedMessage ||
        message?.videoMessage?.contextInfo?.quotedMessage ||
        null
    );
}

// ========== KEEP-ALIVE ==========
setInterval(() => {
    console.log('📡 Keep-alive -', new Date().toLocaleTimeString());
}, 300000);

// ========== TRATAMENTO DE ERROS ==========
process.on('uncaughtException', (err) => {
    console.error('💥 Erro não tratado:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('💥 Promise rejeitada:', err.message);
});

// ========== FUNÇÃO PRINCIPAL ==========
async function connectToWhatsApp() {
    try {
        console.log('🔄 Iniciando conexão...');
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        let adminJid = normalizeAnyJid(state.creds?.me?.id);

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            generateHighQualityLinkPreview: false
        });

        const sendAdmin = async (payload) => {
            const target = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
            if (!target) {
                console.log('Aguardando admin JID...');
                return;
            }

            try {
                await sock.sendMessage(target, payload);
            } catch (err) {
                console.log('Falha ao enviar:', err?.message || err);
            }
        };

        if (!sock.authState.creds.registered) {
            console.log('Nenhuma sessão encontrada. Iniciando processo de pareamento...');
            
            const phoneNumber = normalizeNumber(BOT_NUMBER);
            console.log(`📱 Usando número: ${phoneNumber}`);
            adminJid = toJid(phoneNumber);

            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔑 CÓDIGO DE PAREAMENTO: \x1b[32m${code}\x1b[0m`);
                    console.log('📲 Abra WhatsApp > Aparelhos Conectados > Conectar\n');
                } catch (err) {
                    console.error('Erro ao solicitar código:', err);
                }
            }, 3000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Conexão fechada. Motivo:', lastDisconnect.error?.message);
                
                if (shouldReconnect) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
                        console.log(`⏳ Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} - Reconectando em ${delay/1000}s...`);
                        setTimeout(() => connectToWhatsApp(), delay);
                    } else {
                        console.log('⏰ Muitas tentativas. Aguardando 5 minutos...');
                        setTimeout(() => {
                            reconnectAttempts = 0;
                            connectToWhatsApp();
                        }, 300000);
                    }
                } else {
                    console.log('🚫 Desconectado permanentemente.');
                    process.exit();
                }
            } else if (connection === 'open') {
                reconnectAttempts = 0;
                adminJid = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
                console.log('\n✅✅✅ BOT CONECTADO COM SUCESSO! ✅✅✅\n');
                console.log(`📱 Número: ${adminJid?.split('@')[0]}`);
                
                if (adminJid) {
                    sendAdmin({ text: '✅ Bot conectado com sucesso no Render!' });
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages?.[0];
            if (!msg || !msg.message) return;

            const msgId = msg.key.id;
            
            const isProtocol = msg.message?.protocolMessage?.type === 0;
            
            if (isProtocol) {
                const deletedKeyId = msg.message.protocolMessage.key.id;
                console.log(`[😈] Anti-Delete: ${deletedKeyId}`);
                
                const adminTarget = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
                if (!adminTarget) return;
                
                const deletedMsg = messageLog.get(deletedKeyId);
                if (deletedMsg && !deletedMsg.key.fromMe) {
                    const participant = deletedMsg.key.participant || deletedMsg.key.remoteJid;
                    const participantNumber = participant.split('@')[0];
                    
                    try {
                        await sock.sendMessage(adminTarget, { forward: deletedMsg });
                        await sock.sendMessage(adminTarget, { 
                            text: `🚫 *ANTI-DELETE*\n👤 @${participantNumber}\n🕒 ${new Date().toLocaleTimeString()}`,
                            mentions: [participant]
                        });
                        console.log('[✅] Recuperado!');
                    } catch (e) {
                        console.log("Erro:", e);
                    }
                }
                return;
            }
            
            if (msg.message && !msg.key.fromMe) {
                messageLog.set(msgId, msg);
                setTimeout(() => messageLog.delete(msgId), CACHE_DURATION);
            }

            const from = normalizeAnyJid(msg.key.remoteJid);
            const participant = normalizeAnyJid(msg.key.participant);
            const adminTarget = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
            if (!adminTarget) return;
            
            const sender = msg.key?.fromMe ? adminTarget : (participant || from);
            if (sender !== adminTarget && from !== adminTarget) return;

            const text = getMessageText(msg.message).trim();
            if (!text) return;

            const command = text.split(' ')[0].toLowerCase();
            
            if (command === '.menu') {
                await sendAdmin({ text: `
╔══════════════════╗
     🤖 BOT RENDER
╚══════════════════╝

📸 . - Baixar mídia
🎨 .s - Sticker
🧪 .teste - Teste
⚡ .ping - Latência
📊 .cache - Status
`});
                return;
            }
            
            if (command === '.teste') {
                await sendAdmin({ text: '✅ Online no Render!' });
                return;
            }
            
            if (command === '.ping') {
                const start = Date.now();
                await sendAdmin({ text: '⚡ Pong!' });
                await sendAdmin({ text: `⏱️ ${Date.now() - start}ms` });
                return;
            }
            
            if (command === '.s' || command === '.sticker') {
                try {
                    let imageMessage = msg.message.imageMessage || 
                                      msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                    
                    if (!imageMessage) {
                        await sendAdmin({ text: '❌ | Marque uma foto' });
                        return;
                    }

                    console.log("🎨 Criando sticker...");
                    
                    const stream = await downloadContentFromMessage(imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await(const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    const inputPath = '/tmp/temp_' + Date.now() + '.jpg';
                    const outputPath = '/tmp/temp_' + Date.now() + '.webp';
                    
                    fs.writeFileSync(inputPath, buffer);
                    
                    exec(`ffmpeg -i ${inputPath} -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" -vcodec libwebp -lossless 0 -qscale 80 -loop 0 -an ${outputPath}`, async (error) => {
                        fs.unlinkSync(inputPath);
                        
                        if (error) {
                            console.log('Erro ffmpeg:', error);
                            await sendAdmin({ text: '❌ | Erro na conversão.' });
                            return;
                        }
                        
                        try {
                            const stickerBuffer = fs.readFileSync(outputPath);
                            await sock.sendMessage(adminTarget, { sticker: stickerBuffer });
                            fs.unlinkSync(outputPath);
                            console.log("✅ Sticker criado!");
                        } catch (err) {
                            console.log('Erro:', err);
                            await sendAdmin({ text: '❌ | Erro ao enviar sticker' });
                        }
                    });
                    
                } catch (e) {
                    console.log("Erro sticker:", e);
                    await sendAdmin({ text: '❌ | Erro ao criar sticker' });
                }
                return;
            }
            
            if (command === '.') {
                const quotedMsg = getQuotedMessage(msg.message);

                if (!quotedMsg) {
                    await sendAdmin({ text: '❌ | Marque a mídia' });
                    return;
                }

                try {
                    let viewOnceMsg = quotedMsg.viewOnceMessageV2?.message || quotedMsg.viewOnceMessage?.message || quotedMsg;
                    let mediaType = Object.keys(viewOnceMsg || {})[0];

                    if (!mediaType) {
                        await sendAdmin({ text: '❌ | Não achei mídia' });
                        return;
                    }

                    if (mediaType === 'messageContextInfo') {
                        mediaType = Object.keys(viewOnceMsg || {})[1];
                    }

                    let mediaContent = viewOnceMsg?.[mediaType];
                    let streamType;

                    if (mediaType === 'imageMessage') streamType = 'image';
                    else if (mediaType === 'videoMessage') streamType = 'video';
                    else if (mediaType === 'audioMessage') streamType = 'audio';
                    else {
                        if (quotedMsg.imageMessage) {
                            streamType = 'image';
                            mediaContent = quotedMsg.imageMessage;
                        } else if (quotedMsg.videoMessage) {
                            streamType = 'video';
                            mediaContent = quotedMsg.videoMessage;
                        } else if (quotedMsg.audioMessage) {
                            streamType = 'audio';
                            mediaContent = quotedMsg.audioMessage;
                        } else {
                            await sendAdmin({ text: '❌ | Tipo não suportado' });
                            return;
                        }
                    }

                    const stream = await downloadContentFromMessage(mediaContent, streamType);
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    if (streamType === 'image') {
                        await sendAdmin({ image: buffer, caption: '✅ Aqui' });
                    } else if (streamType === 'video') {
                        await sendAdmin({ video: buffer, caption: '✅ Aqui' });
                    } else if (streamType === 'audio') {
                        await sendAdmin({ audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    }
                } catch (err) {
                    console.log('Erro:', err);
                    await sendAdmin({ text: '❌ | Falha ao baixar' });
                }
            }
        });

        return sock;
    } catch (err) {
        console.error('❌ Erro crítico:', err);
        throw err;
    }
}

async function startBot() {
    try {
        reconnectAttempts = 0;
        await connectToWhatsApp();
    } catch (err) {
        console.error('❌ Erro ao iniciar:', err);
        
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        console.log(`⏳ Tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} em ${delay/1000}s...`);
        
        setTimeout(startBot, delay);
    }
}

startBot();
