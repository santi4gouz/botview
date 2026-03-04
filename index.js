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

// ==================== DETECTAR AMBIENTE ====================
const isRender = process.env.RENDER === 'true' || process.env.IS_RENDER === 'true';
const BOT_NUMBER = process.env.BOT_NUMBER; // Pega da variável de ambiente

// ==================== FUNÇÃO DE PERGUNTA APENAS PARA TERMUX ====================
let question;
if (!isRender) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    question = (text) => new Promise((resolve) => rl.question(text, resolve));
}

// [RAFAX SYSTEM] MEMÓRIA RAM PARA O ANTI-DELETE
const messageLog = new Map();
const CACHE_DURATION = 120000; // 2 minutos

// Cache simples
const jidCache = new Map();

function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

// Com cache
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

async function connectToWhatsApp() {
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
        
        let phoneNumber;
        
        // Se estiver no Render, usa a variável de ambiente
        if (isRender && BOT_NUMBER) {
            phoneNumber = normalizeNumber(BOT_NUMBER);
            console.log(`Usando número da variável de ambiente: ${phoneNumber}`);
            adminJid = toJid(phoneNumber);
        } else if (!isRender && question) {
            // Se estiver no Termux, pergunta interativamente
            phoneNumber = normalizeNumber(await question('Digite o seu número de WhatsApp (ex: 5511999999999): '));
            adminJid = toJid(phoneNumber);
        } else {
            console.error('Número não configurado para ambiente sem terminal!');
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\nSeu código de pareamento é: \x1b[32m${code}\x1b[0m`);
                console.log('Abra o WhatsApp > Aparelhos Conectados > Conectar com número de telefone e insira este código.\n');
            } catch (err) {
                console.error('Erro ao solicitar código de pareamento:', err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Motivo:', lastDisconnect.error?.message);
            if (adminJid) {
                sendAdmin({ text: `⚠️ Conexão fechada: ${lastDisconnect.error?.message || 'motivo desconhecido'}` });
            }
            if (shouldReconnect) {
                console.log('Tentando reconectar...');
                connectToWhatsApp();
            } else {
                console.log('Você foi desconectado. Apague a pasta "auth_info_baileys" e tente novamente.');
                process.exit();
            }
        } else if (connection === 'open') {
            adminJid = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
            console.log('\n=======================================');
            console.log('BOT CONECTADO COM SUCESSO!');
            console.log('=======================================\n');
            if (adminJid) {
                sendAdmin({ text: '✅ Bot conectado com sucesso.' });
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages?.[0];
        if (!msg || !msg.message) return;

        const msgId = msg.key.id;
        
        // ==================== ANTI-DELETE ====================
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
        
        // ==================== SALVAR MENSAGENS ====================
        if (msg.message && !msg.key.fromMe) {
            messageLog.set(msgId, msg);
            setTimeout(() => messageLog.delete(msgId), CACHE_DURATION);
        }

        // ==================== COMANDOS ====================
        const from = normalizeAnyJid(msg.key.remoteJid);
        const participant = normalizeAnyJid(msg.key.participant);
        const adminTarget = adminJid || normalizeAnyJid(sock.authState.creds?.me?.id);
        if (!adminTarget) return;
        
        const sender = msg.key?.fromMe ? adminTarget : (participant || from);
        if (sender !== adminTarget && from !== adminTarget) return;

        const text = getMessageText(msg.message).trim();
        if (!text) return;

        const command = text.split(' ')[0].toLowerCase();
        
        // MENU
        if (command === '.menu') {
            await sendAdmin({ text: `
╔══════════════════╗
     🤖 VIEW BOT
╚══════════════════╝

📸 . - Baixar mídia
🎨 .s - Sticker (foto)
🎨 .sticker - Sticker (foto)
🧪 .teste - Teste
⚡ .ping - Latência
📊 .cache - Status
`});
            return;
        }
        
        // TESTE
        if (command === '.teste') {
            await sendAdmin({ text: '✅ Online!' });
            return;
        }
        
        // PING
        if (command === '.ping') {
            const start = Date.now();
            await sendAdmin({ text: '⚡ Pong!' });
            await sendAdmin({ text: `⏱️ ${Date.now() - start}ms` });
            return;
        }
        
        // CACHE STATUS
        if (command === '.cache') {
            await sendAdmin({
                text: `📊 Cache: ${messageLog.size} msgs\n💾 ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
            });
            return;
        }
        
        // ==================== STICKER COM FFMPEG (FUNCIONAL NO TERMUX) ====================
        if (command === '.s' || command === '.sticker') {
            try {
                // Pega imagem da mensagem ou da mensagem citada
                let imageMessage = msg.message.imageMessage || 
                                  msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
                
                if (!imageMessage) {
                    await sendAdmin({ text: '❌ | Marca uma foto ou responde com .s' });
                    return;
                }

                console.log("🎨 Criando sticker...");
                
                // Baixa a imagem
                const stream = await downloadContentFromMessage(imageMessage, 'image');
                let buffer = Buffer.from([]);
                for await(const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                
                // Salva imagem temporária - caminho adaptado para Render
                const inputPath = '/tmp/temp_' + Date.now() + '.jpg';
                const outputPath = '/tmp/temp_' + Date.now() + '.webp';
                
                fs.writeFileSync(inputPath, buffer);
                
                // Converte com ffmpeg
                exec(`ffmpeg -i ${inputPath} -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" -vcodec libwebp -lossless 0 -qscale 80 -loop 0 -an ${outputPath}`, async (error) => {
                    // Limpa imagem temporária
                    fs.unlinkSync(inputPath);
                    
                    if (error) {
                        console.log('Erro ffmpeg:', error);
                        await sendAdmin({ text: '❌ | Erro na conversão. Verifique se o ffmpeg está instalado.' });
                        return;
                    }
                    
                    try {
                        // Lê o sticker convertido
                        const stickerBuffer = fs.readFileSync(outputPath);
                        
                        // Envia como sticker
                        await sock.sendMessage(adminTarget, { sticker: stickerBuffer });
                        
                        // Limpa arquivo
                        fs.unlinkSync(outputPath);
                        console.log("✅ Sticker criado com sucesso!");
                    } catch (err) {
                        console.log('Erro ao enviar:', err);
                        await sendAdmin({ text: '❌ | Erro ao enviar sticker' });
                    }
                });
                
            } catch (e) {
                console.log("Erro sticker:", e);
                await sendAdmin({ text: '❌ | Erro ao criar sticker' });
            }
            return;
        }
        
        // ==================== BAIXAR MÍDIA (.) ====================
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
}

connectToWhatsApp().catch((err) => {
    console.error('Erro ao iniciar bot:', err);
    process.exit(1);
});
