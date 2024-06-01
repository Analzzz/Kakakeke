const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const util = require('util');
const extract = require('extract-zip');
const archiver = require('archiver');
const { spawn } = require('child_process');

require('./keep_alive'); // Adicionando o keep_alive.js

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();
const upload = multer({ dest: 'uploads/' });
const REPLS = ['https://repl1.example.com', 'https://repl2.example.com'];

let currentStep = {};
let botFolders = {};
let botAssignments = {};
let botLogs = {};
let botProcesses = {};

client.login('');

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    schedulePings();
    monitorRepls();
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const isBotOwner = message.author.id === '1004348688308654150';

    if (message.content === '!uploadbot') {
        handleUploadBotCommand(message);
    } else if (currentStep[message.author.id] === 'awaitingZip' && message.attachments.size > 0) {
        await handleZipUpload(message);
    } else if (message.content === '!console') {
        handleConsoleCommand(message);
    } else if (message.content === '!startbot') {
        handleStartBotCommand(message);
    } else if (message.content === '!stopbot') {
        stopBot(message.author.id, message);
    } else if (message.content === '!statusbot') {
        checkBotStatus(message.author.id, message);
    } else if (message.content === '!help') {
        handleHelpCommand(message);
    } else if (isBotOwner && message.content === '!listrep') {
        handleListRepCommand(message);
    } else if (isBotOwner && message.content === '!replogs') {
        handleRepLogsCommand(message);
    } else if (message.content.startsWith('!removebot')) {
        handleRemoveBotCommand(message);
    } else if (message.content === '!listbot') {
        handleListBotCommand(message);
    }
});

async function handleUploadBotCommand(message) {
    message.channel.send('Por favor, envie o seu arquivo zip contendo todos os arquivos do bot.');
    currentStep[message.author.id] = 'awaitingZip';
}

async function handleZipUpload(message) {
    const attachment = message.attachments.first();
    const zipPath = path.join(__dirname, 'uploads', `${message.author.id}-bot.zip`);
    await downloadFile(attachment.url, zipPath);
    
    const extractPath = path.join(__dirname, 'bots', message.author.id);
    try {
        await extractZip(zipPath, extractPath);
        botFolders[message.author.id] = extractPath;
        message.channel.send('Arquivo zip recebido e extraído. Você pode iniciar o seu bot com o comando `!startbot`.');
        currentStep[message.author.id] = null;
        distributeBot(message.author.id);
    } catch (err) {
        message.channel.send(`Erro ao extrair o arquivo zip: ${err.message}`);
    }
}

function handleConsoleCommand(message) {
    const logs = botLogs[message.author.id] || 'Sem logs disponíveis.';
    message.channel.send(`Logs do bot:\n\`\`\`${logs}\`\`\``);
}

function handleStartBotCommand(message) {
    const userId = message.author.id;
    if (!botFolders[userId]) {
        message.channel.send('Por favor, faça o upload do arquivo zip contendo todos os arquivos do bot usando o comando `!uploadbot` antes de iniciar o bot.');
        return;
    }
    startBot(userId, message);
}

async function downloadFile(url, filePath) {
    const res = await axios.get(url, { responseType: 'stream' });
    const fileStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
        res.data.pipe(fileStream);
        res.data.on('error', reject);
        fileStream.on('finish', resolve);
    });
}

async function extractZip(zipPath, extractPath) {
    await extract(zipPath, { dir: extractPath });
    await setPermissions(extractPath);
}

async function setPermissions(dir) {
    const chmod = util.promisify(fs.chmod);
    const files = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const file of files) {
        const resPath = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            await setPermissions(resPath);
        } else {
            await chmod(resPath, 0o755);
        }
    }
}

function distributeBot(userId) {
    const availableRepl = REPLS.find(repl => !botAssignments[repl]);
    if (availableRepl) {
        botAssignments[availableRepl] = userId;
        sendBotToRepl(availableRepl, botFolders[userId]);
    } else {
        console.log('No available repls to assign the bot.');
    }
}

async function sendBotToRepl(replUrl, botFolder) {
    const zipPath = `${botFolder}.zip`;
    await zipFolder(botFolder, zipPath);
    const form = new FormData();
    form.append('file', fs.createReadStream(zipPath));
    await axios.post(`${replUrl}/upload`, form, { headers: form.getHeaders() });
}

async function zipFolder(folderPath, zipPath) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(zipPath);
    return new Promise((resolve, reject) => {
        archive
            .directory(folderPath, false)
            .on('error', err => reject(err))
            .pipe(stream);
        stream.on('close', () => resolve());
        archive.finalize();
    });
}

function startBot(userId, message) {
    const botFolder = botFolders[userId];
    let startCommand;
    let args = [];

    if (fs.existsSync(path.join(botFolder, 'index.js'))) {
        startCommand = 'node';
        args = ['index.js'];
    } else if (fs.existsSync(path.join(botFolder, 'main.py'))) {
        startCommand = 'python';
        args = ['main.py'];
    } else {
        message.channel.send('Não foi possível identificar o tipo de bot. Certifique-se de que o arquivo principal seja `index.js` ou `main.py`.');
        return;
    }

    if (botProcesses[userId]) {
        message.channel.send('Seu bot já está em execução.');
        return;
    }

    const botProcess = spawn(startCommand, args, { cwd: botFolder });

    botProcess.on('error', (err) => {
        handleBotError(userId, message, err);
    });

    botProcesses[userId] = botProcess;
    botLogs[userId] = '';

    botProcess.stdout.on('data', (data) => {
        botLogs[userId] += data.toString();
    });

    botProcess.stderr.on('data', (data) => {
        botLogs[userId] += data.toString();
    });

    botProcess.on('close', (code) => {
        botLogs[userId] += `Bot process exited with code ${code}\n`;
        if (code !== 0) {
            handleBotError(userId, message, new Error(`Process exited with code ${code}`));
        } else {
            message.channel.send('Bot iniciado com sucesso.');
        }
        delete botProcesses[userId];
    });
}

function handleBotError(userId, message, err) {
    const logs = botLogs[userId] || 'Sem logs disponíveis.';
    message.channel.send(`Erro ao iniciar o bot. Verifique os arquivos e tente novamente.\n\nLogs do bot:\n\`\`\`${logs}\`\`\`\n\nDetalhes do erro: ${err.message}`);
}

function stopBot(userId, message) {
    const botProcess = botProcesses[userId];
    if (!botProcess) {
        message.channel.send('Seu bot não está em execução.');
        return;
    }
    botProcess.kill();
    message.channel.send('Bot parado com sucesso.');
}

function checkBotStatus(userId, message) {
    const botProcess = botProcesses[userId];
    if (botProcess) {
        message.channel.send('Seu bot está em execução.');
    } else {
        message.channel.send('Seu bot não está em execução.');
    }
}

function handleHelpCommand(message) {
    const helpMessage = `
    Comandos disponíveis:
    - \`!uploadbot\`: Envie o seu bot como um arquivo zip.
    - \`!console\`: Veja os logs do seu bot.
    - \`!startbot\`: Inicie o seu bot.
    - \`!stopbot\`: Pare o seu bot.
    - \`!statusbot\`: Verifique se o seu bot está em execução.
    - \`!listbot\`: Veja a localização do seu bot.
    `;
    message.channel.send(helpMessage);
}

async function handleListRepCommand(message) {
    let reply = 'Repls e bots atribuídos:\n';
    for (const repl of REPLS) {
        reply += `${repl}: ${botAssignments[repl] || 'Nenhum bot atribuído'}\n`;
    }
    message.channel.send(reply);
}

async function handleRepLogsCommand(message) {
    const logs = botLogs['bot_owner'] || 'Sem logs disponíveis.';
    message.channel.send(`Logs dos Repls:\n\`\`\`${logs}\`\`\``);
}

async function handleRemoveBotCommand(message) {
    const [_, botName] = message.content.split(' ');
    if (!botName) {
        message.channel.send('Por favor, forneça o nome do bot que deseja remover.');
        return;
    }
    const botFolder = botFolders[message.author.id];
    if (!botFolder || !fs.existsSync(botFolder)) {
        message.channel.send('Nenhum bot encontrado para este usuário.');
        return;
    }

    try {
        await fs.promises.rm(botFolder, { recursive: true, force: true });
        delete botFolders[message.author.id];
        delete botLogs[message.author.id];
        stopBot(message.author.id, message);
        message.channel.send(`Bot "${botName}" removido com sucesso.`);
    } catch (err) {
        message.channel.send(`Erro ao remover o bot: ${err.message}`);
    }
}

async function handleListBotCommand(message) {
    const botFolder = botFolders[message.author.id];
    if (!botFolder) {
        message.channel.send('Você não enviou nenhum bot.');
        return;
    }
    message.channel.send(`Seu bot está localizado em: ${botFolder}`);
}

function schedulePings() {
    cron.schedule('*/5 * * * *', async () => {
        for (const repl of REPLS) {
            try {
                await axios.get(`${repl}/status`);
            } catch (err) {
                console.log(`Repl ${repl} não está respondendo.`);
                redistributeBots(repl);
            }
        }
    });
}

function monitorRepls() {
    setInterval(async () => {
        for (const repl of REPLS) {
            try {
                const response = await axios.get(`${repl}/status`);
                if (response.status !== 200) {
                    console.log(`Repl ${repl} não está saudável.`);
                    redistributeBots(repl);
                }
            } catch (err) {
                console.log(`Erro ao monitorar o repl ${repl}: ${err.message}`);
                redistributeBots(repl);
            }
        }
    }, 30000);
}

function redistributeBots(failedRepl) {
    const failedUserId = botAssignments[failedRepl];
    delete botAssignments[failedRepl];
    if (failedUserId) {
        distributeBot(failedUserId);
    }
}

app.listen(3000, () => {
    console.log('Bot principal rodando na porta 3000.');
});
