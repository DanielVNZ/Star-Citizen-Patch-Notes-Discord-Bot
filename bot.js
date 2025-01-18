// Load environment variables from local.env file
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags } = require('discord.js');
const fs = require('fs');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

// Discord bot setup
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// OpenAI setup
const OpenAI = require('openai');
let openai = null;

// Persistent configuration file
const CONFIG_FILE = '/app/data/config.json';
let serverConfigs = {};

// Load configuration from file
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        serverConfigs = JSON.parse(fs.readFileSync(CONFIG_FILE));
        console.log('Loaded server configurations:', serverConfigs); // Debugging statement
        // Initialize OpenAI with the first available API key
        const firstConfig = Object.values(serverConfigs)[0];
        if (firstConfig && firstConfig.openAiKey) {
            openai = new OpenAI({ apiKey: firstConfig.openAiKey });
        }
        console.log('Configuration loaded.');
    } else {
        console.log('No configuration found. Please run /setup to configure the bot.');
    }
}

// Save configuration to file
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(serverConfigs, null, 4));
    console.log('Configuration saved.');
}

// Reset configuration for a specific server
function resetServerConfig(guildId) {
    if (serverConfigs[guildId]) {
        delete serverConfigs[guildId];
        saveConfig();
    }
    console.log(`Configuration reset for server ${guildId}.`);
}

// Forum URL to monitor
const FORUM_URL = 'https://robertsspaceindustries.com/spectrum/community/SC/forum/190048';

// Variable to store the latest thread URL
let latestThreadUrl = null;

// Function to fetch the latest thread URL
async function getLatestThreadUrl() {
    let browser;

    try {
        console.log('Launching browser to check for updates...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        console.log('Navigating to the forum page...');
        await page.goto(FORUM_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Extracting latest thread link...');
        const latestPostLink = await page.$eval('a.thread-subject', (el) => el.getAttribute('href'));
        if (!latestPostLink) {
            console.error('No latest thread found.');
            return null;
        }

        const latestPostURL = `https://robertsspaceindustries.com${latestPostLink}`;
        console.log(`Latest thread URL: ${latestPostURL}`);

        return latestPostURL;
    } catch (error) {
        console.error('Error fetching latest thread URL:', error);
        return null;
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
}

// Function to process patch notes with ChatGPT
async function processPatchNotesWithChatGPT(content) {
    if (!openai) {
        console.error('OpenAI API key is not set. Please run /setup to configure it.');
        return null;
    }

    try {
        const prompt = `You are a helpful assistant that formats patch notes for Star Citizen. Don't include a release date/time! Besides this, YOU MUST INCLUDE EVERYTHING FROM THE TITLE AT THE TOP TO THE END OF THE TECHNICAL CATEGORY! Make sure to show any special requests or any testing/feedback focus. Include all Known issues, Features & Gameplay, Bug Fixes, and Technical. Use markdown for formatting:\n\n${content}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful assistant that formats patch notes for Star Citizen.' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 3500,
        });

        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error processing patch notes with ChatGPT:', error);
        return null;
    }
}

// Function to fetch and format patch notes
async function getLatestPatchNotesContent(url) {
    let browser;

    try {
        console.log('Launching browser to fetch patch notes...');
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        console.log('Navigating to the latest patch notes page...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log('Waiting for the content to load...');
        await page.waitForSelector('div.content-main', { timeout: 60000 });

        console.log('Extracting patch notes content...');
        const html = await page.content();
        const $ = cheerio.load(html);

        const contentMain = $('div.content-main');
        if (!contentMain.length) {
            console.error('No content found in the main container.');
            return null;
        }

        const rawContent = contentMain.text().trim();
        if (!rawContent) {
            console.error('No content extracted from the patch notes page.');
            return null;
        }

        const formattedContent = await processPatchNotesWithChatGPT(rawContent);
        if (!formattedContent) {
            console.error('ChatGPT failed to process the patch notes.');
            return null;
        }

        return { url, content: formattedContent };
    } catch (error) {
        console.error('Error fetching patch notes content:', error);
        return null;
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
}

// Function to check for updates and post patch notes
async function checkForUpdates() {
    console.log('Checking for updates...');
    if (Object.keys(serverConfigs).length === 0) {
        console.error('No servers configured. Please run /setup to configure the bot.');
        return;
    }

    const latestUrl = await getLatestThreadUrl();

    if (latestUrl && latestUrl !== latestThreadUrl) {
        console.log('New thread detected! Fetching patch notes...');
        latestThreadUrl = latestUrl;

        const patchNotesData = await getLatestPatchNotesContent(latestUrl);
        if (patchNotesData) {
            const { url, content } = patchNotesData;

            if (!content) {
                console.error('Patch notes content is empty or null. Skipping posting.');
                return;
            }

            // Send to all configured servers
            for (const [guildId, config] of Object.entries(serverConfigs)) {
                try {
                    const channel = await client.channels.fetch(config.channelId).catch(() => null);
                    if (channel) {
                        const roleMention = config.pingRoleId ? `<@&${config.pingRoleId}>` : '';
                        await channel.send(`${roleMention} **New Star Citizen Patch Notes:**\n${url}`);

                        const parts = content.match(/.{1,2000}/gs) || [];
                        for (const part of parts) {
                            await channel.send(part);
                        }
                        console.log(`Patch notes posted in server ${guildId}`);
                    }
                } catch (error) {
                    console.error(`Error posting to server ${guildId}:`, error);
                }
            }
        }
    }
}

// Command handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'setup') {
        try {
            await interaction.deferReply({ ephemeral: true });

            const channel = interaction.options.getChannel('channel');
            const pingRole = interaction.options.getRole('pingrole');
            const openAiKey = interaction.options.getString('openai_key');

            if (!openAiKey) {
                await interaction.editReply('An OpenAI API key is required to set up the bot. Please provide one.');
                console.error('OpenAi API key not provided during setup.');
                return;
            }

            // Save server-specific configuration
            serverConfigs[interaction.guildId] = {
                channelId: channel.id,
                pingRoleId: pingRole ? pingRole.id : null,
                openAiKey: openAiKey
            };
            
            saveConfig();

            // Initialize OpenAI if not already initialized
            if (!openai) {
                openai = new OpenAI({ apiKey: openAiKey });
            }

            await interaction.editReply({
                content: `Patch notes will now be posted in <#${channel.id}>${
                    pingRole ? ` and will ping <@&${pingRole.id}>` : ''
                }.`
            });

            console.log(
                `Setup complete: Channel ID = ${channel.id}, Ping Role ID = ${
                    pingRole ? pingRole.id : 'None'
                }, OpenAI Key Provided: ${!!openAiKey}`
            );
        } catch (error) {
            console.error('Error handling /setup command:', error.message);

            // Attempt to reply with an error message if the interaction isn't replied to
            try {
                await interaction.editReply('An error occurred while processing your request.');
            } catch (replyError) {
                console.error('Failed to edit reply:', replyError.message);
            }
        }
    } else if (interaction.commandName === 'patchnotes') {
        const serverConfig = serverConfigs[interaction.guildId];
        console.log('Server configuration for patchnotes command:', serverConfig); // Debugging statement
        if (!serverConfig) {
            await interaction.reply({
                content: 'This server is not configured. Please run `/setup` first.',
                ephemeral: true
            });
            return;
        }

        try {
            await interaction.deferReply();

            const patchNotesData = await getLatestPatchNotesContent(latestThreadUrl);
            if (patchNotesData) {
                const { url, content } = patchNotesData;

                const channel = await client.channels.fetch(serverConfig.channelId).catch((err) => {
                    console.error('Error fetching channel:', err.message);
                    return null;
                });

                if (!channel) {
                    console.error('Command invoked in an invalid or undefined channel.');
                    await interaction.editReply('An error occurred: the channel could not be determined.');
                    return;
                }

                const roleMention = serverConfig.pingRoleId ? `<@&${serverConfig.pingRoleId}>` : '';
                await channel.send(`${roleMention} **Latest Star Citizen Patch Notes:**
${url}`);

                const parts = content.match(/.{1,2000}/gs) || [];
                for (const part of parts) {
                    await channel.send(part);
                }

                await interaction.editReply('Patch notes have been posted.');

            } else {
                await interaction.editReply('Could not fetch the latest patch notes. Please try again later.');
            }
        } catch (error) {
            console.error('Error handling /patchnotes command:', error.message);
            try {
                await interaction.editReply('An unexpected error occurred while processing your request.');
            } catch (replyError) {
                console.error('Failed to edit reply:', replyError.message);
            }
        }
    }
});

// Login to Discord
client.login(process.env.TOKEN);

// Slash command registration
const commands = [
    {
        name: 'patchnotes',
        description: 'Fetch the latest Star Citizen patch notes',
    },
    {
        name: 'setup',
        description: 'Set up the bot to post patch notes and configure OpenAI',
        options: [
            {
                name: 'channel',
                type: 7, // Channel type
                description: 'The channel where the bot should post patch notes',
                required: true,
            },
            {
                name: 'openai_key',
                type: 3, // String type
                description: 'Your OpenAI API key (required)',
                required: true,
            },
            {
                name: 'pingrole',
                type: 8, // Role type
                description: 'The role to ping when new patch notes are posted (optional)',
                required: false,
            },
        ],
    },
];



const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// Start polling for updates
client.once('ready', async () => {
    console.log('Bot is ready!');
    loadConfig(); // Add this line to load configurations on startup
    latestThreadUrl = await getLatestThreadUrl();
    setInterval(checkForUpdates, 60000); // Check for updates every 60 seconds
});
