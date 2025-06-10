const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Collection, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');

// Bot configuration
const config = {
    token: 'token_goes_here', // Replace with your bot token
    bankChannelName: 'bank-requests', // The thread/channel for requests
    bankApiUrl: 'https://thj-dnt.web.app/assets/', // Base URL for inventory files
    firebase: {
        apiKey: "AIzaSyC8J9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z9Z", // Will be replaced
        authDomain: "thj-dnt.firebaseapp.com",
        projectId: "thj-dnt",
        storageBucket: "thj-dnt.appspot.com",
        messagingSenderId: "123456789",
        appId: "1:123456789:web:abcdef123456789"
    }
};

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Initialize Firebase
const firebaseApp = initializeApp(config.firebase);
const db = getFirestore(firebaseApp);

// Store bank data and user carts
let bankData = {
    items: new Map(),
    itemsByClass: new Map(), // Maps class -> array of items
    spellsByClass: new Map(), // Maps class -> array of spell items
    inventoryFiles: new Map(), // Maps filename -> file content
    lastUpdated: null
};

// User shopping carts - stores items per user
const userCarts = new Map();

// Active requests - stores pending bank requests with IDs
const activeRequests = new Map();
let requestIdCounter = 1;

// Load class mappings from website
let itemIdsByClass = {};
let spellIdsByClass = {};

// Load item IDs by class from the website
async function loadItemIdsByClass() {
    try {
        console.log('Loading item IDs by class from website...');
        const response = await fetch('https://thj-dnt.web.app/assets/item-ids-by-class.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        itemIdsByClass = await response.json();
        console.log(`Loaded item classifications for ${Object.keys(itemIdsByClass).length} classes`);
        return true;
    } catch (error) {
        console.error('Failed to load item IDs by class:', error);
        return false;
    }
}

// Load inventory data from Firebase Firestore
async function loadInventoryFromFirestore() {
    try {
        console.log('Loading inventory from Firestore...');
        const itemsCollection = collection(db, 'items');
        const querySnapshot = await getDocs(itemsCollection);
        
        let filesLoaded = 0;
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            // Store the raw file data
            bankData.inventoryFiles.set(data.name, data.data);
            filesLoaded++;
        });
        
        console.log(`Loaded ${filesLoaded} inventory files from Firestore`);
        
        // Parse the inventory files to create searchable items
        await parseInventoryFiles();
        
        return true;
    } catch (error) {
        console.error('Failed to load from Firestore:', error);
        return false;
    }
}

// Helper function to parse bank file format (from bank.component.ts logic)
function outputFileToJson(data, filter = undefined) {
    const items = [];
    
    try {
        // First try parsing as JSON
        const jsonData = JSON.parse(data);
        
        if (Array.isArray(jsonData)) {
            return jsonData;
        } else if (typeof jsonData === 'object') {
            // Convert object to array format
            Object.entries(jsonData).forEach(([id, itemData]) => {
                items.push({
                    id: parseInt(id),
                    ...itemData
                });
            });
            return items;
        }
    } catch (e) {
        // If not JSON, parse as custom format
        // Expected format: itemId|itemName|baseCount|enchantedCount|legendaryCount
        const lines = data.split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
            const parts = line.split('|');
            if (parts.length >= 3) {
                const item = {
                    id: parseInt(parts[0]),
                    name: parts[1],
                    baseCount: parseInt(parts[2]) || 0,
                    enchantedCount: parseInt(parts[3]) || 0,
                    legendaryCount: parseInt(parts[4]) || 0
                };
                
                if (filter && !item.name.toLowerCase().includes(filter.toLowerCase())) {
                    return;
                }
                
                items.push(item);
            }
        });
    }
    
    return items;
}

// Determine if an item is a spell based on its ID
function isSpellItemById(itemId) {
    // In EverQuest, spell item IDs typically fall within certain ranges
    // This is a simplified check - adjust based on your actual data
    return itemId >= 15000 && itemId <= 40000;
}

// Parse inventory files and create item database
async function parseInventoryFiles() {
    console.log('Parsing inventory files and building searchable database...');
    
    // Clear existing data
    bankData.items.clear();
    bankData.itemsByClass.clear();
    bankData.spellsByClass.clear();
    
    // Initialize class maps
    const allClasses = ['Bard', 'Beastlord', 'Berserker', 'Cleric', 'Druid', 'Enchanter', 
                       'Magician', 'Monk', 'Necromancer', 'Paladin', 'Ranger', 'Rogue', 
                       'Shadowknight', 'Shaman', 'Warrior', 'Wizard'];
    
    allClasses.forEach(className => {
        bankData.itemsByClass.set(className.toLowerCase(), []);
        bankData.spellsByClass.set(className.toLowerCase(), []);
    });
    
    let totalItems = 0;
    let totalSpells = 0;
    
    // Process each inventory file
    for (const [filename, fileContent] of bankData.inventoryFiles) {
        console.log(`Processing ${filename}...`);
        
        // Determine category from filename (following bank.component.ts logic)
        const category = filename.substring(3).split('-')[0]; // Remove 'dnt' prefix
        const isSpellFile = category === 'spell' || filename.includes('spell');
        
        // Parse the file content
        const items = outputFileToJson(fileContent);
        
        for (const item of items) {
            if (!item.name || !item.id) continue;
            
            const itemData = {
                id: item.id,
                name: item.name,
                baseCount: item.baseCount || item.raw || 0,
                enchantedCount: item.enchantedCount || item.enchanted || 0,
                legendaryCount: item.legendaryCount || item.legendary || 0,
                location: filename.replace('.json', '').replace('.txt', ''),
                isSpell: isSpellFile || isSpellItemById(item.id) || isSpellItem(item.name.toLowerCase())
            };
            
            // Add to main items map
            bankData.items.set(item.name.toLowerCase(), itemData);
            
            // Classify item by class
            if (itemIdsByClass) {
                for (const [className, itemIds] of Object.entries(itemIdsByClass)) {
                    if (itemIds.includes(item.id)) {
                        const classKey = className.toLowerCase();
                        
                        if (itemData.isSpell) {
                            const spellList = bankData.spellsByClass.get(classKey) || [];
                            spellList.push(itemData);
                            bankData.spellsByClass.set(classKey, spellList);
                            totalSpells++;
                        } else {
                            const itemList = bankData.itemsByClass.get(classKey) || [];
                            itemList.push(itemData);
                            bankData.itemsByClass.set(classKey, itemList);
                        }
                    }
                }
                
                // Items in 'All' category
                if (itemIdsByClass['All'] && itemIdsByClass['All'].includes(item.id)) {
                    // Add to all classes
                    allClasses.forEach(className => {
                        const classKey = className.toLowerCase();
                        if (itemData.isSpell) {
                            const spellList = bankData.spellsByClass.get(classKey) || [];
                            if (!spellList.find(s => s.id === item.id)) {
                                spellList.push(itemData);
                                bankData.spellsByClass.set(classKey, spellList);
                            }
                        } else {
                            const itemList = bankData.itemsByClass.get(classKey) || [];
                            if (!itemList.find(i => i.id === item.id)) {
                                itemList.push(itemData);
                                bankData.itemsByClass.set(classKey, itemList);
                            }
                        }
                    });
                }
            }
            
            totalItems++;
        }
    }
    
    // Sort spells by name for each class
    for (const [className, spells] of bankData.spellsByClass) {
        spells.sort((a, b) => a.name.localeCompare(b.name));
    }
    
    console.log(`✅ Parsing complete!`);
    console.log(`📊 Total items: ${totalItems}`);
    console.log(`📜 Total spells: ${totalSpells}`);
    console.log(`📁 From ${bankData.inventoryFiles.size} inventory files`);
    
    // Log spell counts by class
    console.log('\n📜 Spell inventory by class:');
    for (const [className, spells] of bankData.spellsByClass) {
        if (spells.length > 0) {
            console.log(`  ${className}: ${spells.length} spells`);
        }
    }
    
    bankData.lastUpdated = new Date();
}

// Enhanced spell detection
function isSpellItem(itemName) {
    const spellIndicators = [
        'spell:',
        'song:',
        'tome of',
        'words of',
        'rune of',
        'scroll of',
        'incantation of',
        'chant of',
        'hymn of',
        'greater spell of',
        'lesser spell of',
        'major spell of',
        'minor spell of',
        'ancient spell:',
        'lost scroll of',
        'grimoire of',
        'codex of',
        'manuscript:',
        'parchment:'
    ];
    
    return spellIndicators.some(indicator => itemName.includes(indicator));
}

// Initialize item data 
async function initializeBankData() {
    console.log('Initializing bank data...');
    
    // Load class mappings first
    const classMapSuccess = await loadItemIdsByClass();
    if (!classMapSuccess) {
        console.warn('⚠️  Could not load class mappings, spell search may be limited');
    }
    
    // Try to load real inventory from Firestore
    const firestoreSuccess = await loadInventoryFromFirestore();
    if (firestoreSuccess) {
        console.log('✅ Firestore inventory loaded successfully!');
        console.log(`📊 Total items available: ${bankData.items.size}`);
    } else {
        console.log('❌ Failed to load inventory from Firestore.');
        console.log('⚠️  Bot will have limited functionality without inventory data.');
    }
    
    console.log('✅ Bank data initialization complete!');
}

// Get or create user cart
function getUserCart(userId) {
    if (!userCarts.has(userId)) {
        userCarts.set(userId, []);
    }
    return userCarts.get(userId);
}

// Search function
async function searchItems(query) {
    const results = [];
    const searchTerm = query.toLowerCase().trim();
    
    // Check for various spell class search patterns
    const spellPatterns = [
        /^spell\s+(\w+)$/,           // "spell wizard"
        /^spells\s+(\w+)$/,          // "spells wizard"
        /^(\w+)\s+spell$/,           // "wizard spell"
        /^(\w+)\s+spells$/,          // "wizard spells"
        /^show\s+(\w+)\s+spells$/,   // "show wizard spells"
        /^list\s+(\w+)\s+spells$/    // "list wizard spells"
    ];
    
    for (const pattern of spellPatterns) {
        const match = searchTerm.match(pattern);
        if (match) {
            const className = match[1];
            return searchSpellsByClass(className);
        }
    }
    
    // Regular item search
    for (const [key, item] of bankData.items) {
        if (key.includes(searchTerm) && results.length < 10) {
            results.push(item);
        }
    }
    
    return results;
}

// Search for spells by class
function searchSpellsByClass(className) {
    const classSearchTerm = className.toLowerCase();
    
    // Class abbreviations and full names
    const classMap = {
        // Casters
        'mag': 'magician',
        'mage': 'magician',
        'magician': 'magician',
        'nec': 'necromancer',
        'necro': 'necromancer',
        'necromancer': 'necromancer',
        'wiz': 'wizard',
        'wizard': 'wizard',
        'enc': 'enchanter',
        'ench': 'enchanter',
        'enchanter': 'enchanter',
        'dru': 'druid',
        'druid': 'druid',
        'sha': 'shaman',
        'sham': 'shaman',
        'shaman': 'shaman',
        'cle': 'cleric',
        'clr': 'cleric',
        'cleric': 'cleric',
        // Hybrids
        'pal': 'paladin',
        'pally': 'paladin',
        'paladin': 'paladin',
        'sk': 'shadowknight',
        'shadow': 'shadowknight',
        'shadowknight': 'shadowknight',
        'ran': 'ranger',
        'rng': 'ranger',
        'ranger': 'ranger',
        'bst': 'beastlord',
        'beast': 'beastlord',
        'beastlord': 'beastlord',
        'brd': 'bard',
        'bard': 'bard',
        // Melee (usually don't have spells but included for completeness)
        'ber': 'berserker',
        'berserker': 'berserker',
        'mnk': 'monk',
        'monk': 'monk',
        'rog': 'rogue',
        'rogue': 'rogue',
        'war': 'warrior',
        'warrior': 'warrior'
    };
    
    const fullClassName = classMap[classSearchTerm] || classSearchTerm;
    
    // Get spells for this class from the pre-sorted spell map
    const classSpells = bankData.spellsByClass.get(fullClassName) || [];
    
    // If no spells found in the class map, fall back to searching all items
    if (classSpells.length === 0) {
        console.log(`No pre-classified spells for ${fullClassName}, searching all items...`);
        const results = [];
        
        for (const [key, item] of bankData.items) {
            if (item.isSpell && containsClassName(item.name, fullClassName, classSearchTerm)) {
                results.push(item);
                if (results.length >= 25) break;
            }
        }
        
        return results;
    }
    
    // Return up to 25 spells for the class
    return classSpells.slice(0, 25);
}

// Check if item name contains the class name
function containsClassName(itemName, fullClassName, searchTerm) {
    const lowerName = itemName.toLowerCase();
    
    // Check for full class name or abbreviation
    if (lowerName.includes(fullClassName) || lowerName.includes(searchTerm)) {
        return true;
    }
    
    // Check for class-specific spell patterns
    const classSpellPatterns = {
        'wizard': ['burnout', 'ice comet', 'lure', 'evacuate', 'gate', 'familiar'],
        'magician': ['summon', 'elemental', 'pet haste', 'burnout', 'mage armor'],
        'necromancer': ['lich', 'darkness', 'feign death', 'lifetap', 'undead', 'disease'],
        'enchanter': ['clarity', 'haste', 'slow', 'mez', 'charm', 'illusion', 'rune'],
        'cleric': ['heal', 'cure', 'resurrection', 'divine', 'celestial', 'aegis'],
        'druid': ['snare', 'root', 'regeneration', 'port', 'harmony', 'nature'],
        'shaman': ['slow', 'haste', 'cannibalize', 'ancestral', 'spirit', 'focus'],
        'paladin': ['lay hands', 'divine', 'holy', 'valor', 'blessing', 'guard'],
        'shadowknight': ['harm touch', 'darkness', 'terror', 'shadow', 'disease'],
        'ranger': ['snare', 'track', 'camouflage', 'trueshot', 'call'],
        'beastlord': ['spiritual', 'feral', 'savage', 'warder', 'pet'],
        'bard': ['selo', 'song', 'melody', 'chorus', 'chant', 'composition']
    };
    
    const patterns = classSpellPatterns[fullClassName] || [];
    return patterns.some(pattern => lowerName.includes(pattern));
}

// Format item for display
function formatItem(item) {
    const qualities = [];
    if (item.baseCount > 0) qualities.push(`Raw: ${item.baseCount}`);
    if (item.enchantedCount > 0) qualities.push(`Enchanted: ${item.enchantedCount}`);
    if (item.legendaryCount > 0) qualities.push(`Legendary: ${item.legendaryCount}`);
    
    const qualityText = qualities.length > 0 ? ` (${qualities.join(', ')})` : '';
    return `${item.name}${qualityText}`;
}

// Format item for request (no raw quality)
function formatItemForRequest(cartItem) {
    let qualityText = '';
    
    if (cartItem.quality === 'enchanted') {
        qualityText = ' (Enchanted)';
    } else if (cartItem.quality === 'legendary') {
        qualityText = ' (Legendary)';
    }
    // Raw items get no quality suffix
    
    return `${cartItem.name}${qualityText}`;
}

// Get available qualities for an item
function getAvailableQualities(item) {
    const qualities = [];
    if (item.baseCount > 0) qualities.push('raw');
    if (item.enchantedCount > 0) qualities.push('enchanted');
    if (item.legendaryCount > 0) qualities.push('legendary');
    return qualities;
}

// Get highest quality available for an item
function getHighestQuality(item) {
    if (item.legendaryCount > 0) return 'legendary';
    if (item.enchantedCount > 0) return 'enchanted';
    if (item.baseCount > 0) return 'raw';
    return 'raw'; // Default fallback
}

// Create clickable item name buttons
function createItemButtons(items, userId) {
    const buttons = [];
    
    items.forEach(item => {
        const highestQuality = getHighestQuality(item);
        if (highestQuality) {
            const button = new ButtonBuilder()
                .setCustomId(`additem_${userId}_${item.name}_${highestQuality}`)
                .setLabel(item.name.substring(0, 80)) // Discord button label limit
                .setStyle(ButtonStyle.Primary);
            
            buttons.push(button);
        }
    });
    
    return buttons;
}

// Create cart management buttons
function createCartButtons(userId) {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`cart_clear_${userId}`)
                .setLabel('Clear Cart')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`cart_submit_${userId}`)
                .setLabel('Submit Request')
                .setStyle(ButtonStyle.Success)
        );
}

// Helper function to create a spell-specific embed
function createSpellSearchEmbed(results, className, userId) {
    const capitalizedClass = className.charAt(0).toUpperCase() + className.slice(1);
    
    const embed = new EmbedBuilder()
        .setTitle(`📜 ${capitalizedClass} Spells in Bank`)
        .setColor(0x9C27B0) // Purple for magic
        .setDescription(`**Found ${results.length} spell(s) for ${capitalizedClass}**\n*Click spell names to add to cart*`)
        .setFooter({ text: 'Showing up to 25 spells • Use /cart to view selections' });
    
    // Add spell list as a single field to save space
    if (results.length > 0) {
        const spellList = results.slice(0, 10).map((spell, index) => {
            const qualities = [];
            if (spell.baseCount > 0) qualities.push(`R:${spell.baseCount}`);
            if (spell.enchantedCount > 0) qualities.push(`E:${spell.enchantedCount}`);
            if (spell.legendaryCount > 0) qualities.push(`L:${spell.legendaryCount}`);
            
            return `${index + 1}. **${spell.name}** (${qualities.join(', ')})`;
        }).join('\n');
        
        embed.addFields({
            name: 'Available Spells',
            value: spellList,
            inline: false
        });
        
        if (results.length > 10) {
            embed.addFields({
                name: 'Additional Info',
                value: `Showing first 10 of ${results.length} spells. Click buttons below to add any spell to cart.`,
                inline: false
            });
        }
    }
    
    return embed;
}

// Slash commands (keeping all existing commands)
const commands = [
    new SlashCommandBuilder()
        .setName('request')
        .setDescription('Open a form to request multiple items at once'),
    
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search for items by name or spells by class')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Item name OR "spell [class]" (e.g., "spell wizard")')
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName('cart')
        .setDescription('View and manage your shopping cart')
        .addStringOption(option =>
            option.setName('character')
                .setDescription('Character name to send items to (required to submit)')
                .setRequired(false)
        ),
    
    new SlashCommandBuilder()
        .setName('banklist')
        .setDescription('Get link to browse the full bank inventory website'),
    
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all available commands and how to use the bank bot'),
    
    new SlashCommandBuilder()
        .setName('fulfill')
        .setDescription('[STAFF] Mark a bank request as fulfilled')
        .addIntegerOption(option =>
            option.setName('request-id')
                .setDescription('Request ID number to fulfill')
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName('deny')
        .setDescription('[STAFF] Deny a bank request due to unavailable items')
        .addIntegerOption(option =>
            option.setName('request-id')
                .setDescription('Request ID number to deny')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for denial (e.g., "Sword of Flame out of stock")')
                .setRequired(true)
        ),
    
    new SlashCommandBuilder()
        .setName('partial')
        .setDescription('[STAFF] Partially fulfill request - some items sent, others unavailable')
        .addIntegerOption(option =>
            option.setName('request-id')
                .setDescription('Request ID number')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('sent-items')
                .setDescription('Items that were sent (comma separated)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('unavailable-items')
                .setDescription('Items that were unavailable (comma separated)')
                .setRequired(true)
        )
];

// Event handlers
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    
    // Initialize bank data
    await initializeBankData();
    
    // Register slash commands
    try {
        console.log('Registering slash commands...');
        await client.application.commands.set(commands);
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
        await handleButtonClick(interaction);
    } else if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
    }
});

async function handleSlashCommand(interaction) {
    const { commandName, options, user } = interaction;

    try {
        switch (commandName) {
            case 'request': {
                // Open the request form modal
                const modal = new ModalBuilder()
                    .setCustomId(`requestModal_${user.id}`)
                    .setTitle('🎒 Guild Bank Request Form');

                // Items input (big text area)
                const itemsInput = new TextInputBuilder()
                    .setCustomId('itemsInput')
                    .setLabel('Items to Request (one per line)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Enter items with optional quality:\nSword of Flame\nVelium Shield (Enchanted)\nFlowing Black Silk Sash (Raw)\n\nNo quality = Raw version')
                    .setRequired(true)
                    .setMaxLength(1000);

                // Character name input
                const characterInput = new TextInputBuilder()
                    .setCustomId('characterInput')
                    .setLabel('Character Name (where to send items)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Enter character name')
                    .setRequired(true)
                    .setMaxLength(50);

                // Notes input (optional)
                const notesInput = new TextInputBuilder()
                    .setCustomId('notesInput')
                    .setLabel('Additional Notes (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Any special instructions or notes')
                    .setRequired(false)
                    .setMaxLength(200);

                // Add inputs to action rows
                const firstActionRow = new ActionRowBuilder().addComponents(itemsInput);
                const secondActionRow = new ActionRowBuilder().addComponents(characterInput);
                const thirdActionRow = new ActionRowBuilder().addComponents(notesInput);

                modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);

                // Show the modal
                await interaction.showModal(modal);
                break;
            }
            
            case 'search': {
                const query = options.getString('query');
                
                try {
                    const results = await searchItems(query);
                    
                    if (!results || results.length === 0) {
                        await interaction.reply({
                            content: `No items found matching "${query}". Try a different search term.`,
                            ephemeral: true
                        });
                        return;
                    }
                    
                    // Check if this is a spell search
                    const isSpellSearch = query.toLowerCase().match(/spell\s+(\w+)/);
                    
                    if (isSpellSearch) {
                        // Use special spell embed
                        const className = isSpellSearch[1];
                        const embed = createSpellSearchEmbed(results, className, user.id);
                        
                        // Create clickable spell buttons
                        const itemButtons = createItemButtons(results, user.id);
                        const actionRows = [];
                        
                        // Split buttons into rows of 5 (Discord limit)
                        for (let i = 0; i < itemButtons.length; i += 5) {
                            const buttonChunk = itemButtons.slice(i, i + 5);
                            actionRows.push(new ActionRowBuilder().addComponents(...buttonChunk));
                        }
                        
                        // Limit to 5 rows (25 buttons total) due to Discord limits
                        const limitedActionRows = actionRows.slice(0, 5);
                        
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: limitedActionRows,
                            ephemeral: true 
                        });
                    } else {
                        // Regular item search
                        const embed = new EmbedBuilder()
                            .setTitle(`🔍 Search Results for "${query}"`)
                            .setColor(0x2196F3)
                            .setDescription('**Click item names below to add to your cart!**\n*Highest available quality will be added automatically.*')
                            .setFooter({ text: `Found ${results.length} item(s) • Use /cart to view your cart` });
                        
                        // Add each item as a field showing available qualities
                        results.forEach((item, index) => {
                            const qualities = [];
                            if (item.baseCount > 0) qualities.push(`Raw: ${item.baseCount}`);
                            if (item.enchantedCount > 0) qualities.push(`Enchanted: ${item.enchantedCount}`);
                            if (item.legendaryCount > 0) qualities.push(`Legendary: ${item.legendaryCount}`);
                            
                            embed.addFields({
                                name: `${index + 1}. ${item.name}`,
                                value: `Available: ${qualities.join(', ')}\n*Will add: highest quality available*`,
                                inline: false
                            });
                        });
                        
                        // Create clickable item buttons
                        const itemButtons = createItemButtons(results, user.id);
                        const actionRows = [];
                        
                        // Split buttons into rows of 5 (Discord limit)
                        for (let i = 0; i < itemButtons.length; i += 5) {
                            const buttonChunk = itemButtons.slice(i, i + 5);
                            actionRows.push(new ActionRowBuilder().addComponents(...buttonChunk));
                        }
                        
                        await interaction.reply({ 
                            embeds: [embed], 
                            components: actionRows,
                            ephemeral: true 
                        });
                    }
                } catch (error) {
                    console.error('Search error:', error);
                    await interaction.reply({
                        content: 'An error occurred while searching. Please try again.',
                        ephemeral: true
                    });
                }
                break;
            }
            
            case 'cart': {
                const characterName = options.getString('character');
                const userCart = getUserCart(user.id);
                
                if (characterName && userCart.length > 0) {
                    // Submit the cart
                    await submitCart(interaction, user.id, characterName);
                } else {
                    // Show cart contents
                    await showCart(interaction, user.id);
                }
                break;
            }
            
            case 'banklist': {
                const embed = new EmbedBuilder()
                    .setTitle('🏦 Guild Bank Inventory')
                    .setColor(0xFF9800)
                    .setDescription('Click the link below to browse the full bank inventory with item stats and descriptions.')
                    .addFields({
                        name: '🔗 Full Bank Website',
                        value: '[**Browse Bank Inventory →**](https://thj-dnt.web.app/bank)',
                        inline: false
                    })
                    .addFields({
                        name: '💡 How to Request Items',
                        value: '1. Browse items on the website\n2. Come back to Discord\n3. Use `/search ItemName` to find what you want\n4. Click add buttons to build your cart\n5. Use `/cart character:YourName` to submit',
                        inline: false
                    })
                    .setFooter({ text: 'No need to type long item names - just use the search and add buttons!' });

                await interaction.reply({ 
                    embeds: [embed], 
                    ephemeral: true 
                });
                break;
            }
            
            case 'help': {
                const embed = new EmbedBuilder()
                    .setTitle('🤖 Clockwork Banker - Command Help')
                    .setColor(0x2196F3)
                    .setDescription('Here are all the commands you can use with the guild bank bot:')
                    .addFields(
                        {
                            name: '👥 **Player Commands**',
                            value: '**`/search ItemName`** - Search for items by full or partial name\n' +
                                   '• Examples: `/search sword`, `/search truth`, `/search sword of truth`\n' +
                                   '• Click item names to add to your cart\n\n' +
                                   '**`/search spell [class]`** - Search for spells by class\n' +
                                   '• Examples: `/search spell wizard`, `/search spell enc`, `/search spell necro`\n' +
                                   '• Supported: mag, nec, wiz, enc, dru, sha, cle, pal, sk, ran, bst, brd, mnk, rog, war\n\n' +
                                   '**`/request`** - Open form to request multiple items at once\n' +
                                   '• Type items one per line with optional quality\n' +
                                   '• Example: "Sword of Flame (Enchanted)"\n\n' +
                                   '**`/cart`** - View your shopping cart\n' +
                                   '**`/cart character:YourName`** - Submit cart as a request\n\n' +
                                   '**`/banklist`** - Get link to browse full bank website\n\n' +
                                   '**`/help`** - Show this help message',
                            inline: false
                        },
                        {
                            name: '📜 **Spell Search Tips**',
                            value: '• Use class abbreviations: mag, nec, wiz, enc, etc.\n' +
                                   '• Spells are sorted alphabetically\n' +
                                   '• Shows all available qualities (Raw/Enchanted/Legendary)\n' +
                                   '• Click spell names to add to cart just like items',
                            inline: false
                        },
                        {
                            name: '🛡️ **Staff Commands**',
                            value: '**`/fulfill request-id:1234`** - Mark request as completed\n' +
                                   '**`/deny request-id:1234 reason:"Out of stock"`** - Deny request\n' +
                                   '**`/partial request-id:1234 sent-items:"..." unavailable-items:"..."`** - Partial fulfillment',
                            inline: false
                        },
                        {
                            name: '📋 **How to Use**',
                            value: '1. **Browse** → Use `/banklist` to view full inventory\n' +
                                   '2. **Search** → Use `/search ItemName` or `/search spell class`\n' +
                                   '3. **Add** → Click item/spell names to add to cart\n' +
                                   '4. **Submit** → Use `/cart character:YourName` to request\n' +
                                   '5. **Staff** → Processes requests with fulfill/deny/partial commands',
                            inline: false
                        }
                    )
                    .setFooter({ text: 'Questions? Ask in #bank-requests channel!' });

                await interaction.reply({ 
                    embeds: [embed], 
                    ephemeral: true 
                });
                break;
            }
            
            case 'fulfill': {
                await handleOfficerCommand(interaction, 'fulfill');
                break;
            }
            
            case 'deny': {
                await handleOfficerCommand(interaction, 'deny');
                break;
            }
            
            case 'partial': {
                await handleOfficerCommand(interaction, 'partial');
                break;
            }
        }
    } catch (error) {
        console.error('Error handling command:', error);
        await interaction.reply({
            content: 'An error occurred while processing your command.',
            ephemeral: true
        });
    }
}

async function handleButtonClick(interaction) {
    const [action, userId, ...rest] = interaction.customId.split('_');
    
    // Only allow users to interact with their own buttons
    if (userId !== interaction.user.id) {
        await interaction.reply({
            content: 'You can only use your own cart buttons!',
            ephemeral: true
        });
        return;
    }
    
    try {
        if (action === 'additem') {
            const quality = rest.pop(); // Last element is quality
            const itemName = rest.join('_'); // Rejoin the item name
            
            const item = bankData.items.get(itemName.toLowerCase());
            if (!item) {
                await interaction.reply({
                    content: 'Item not found!',
                    ephemeral: true
                });
                return;
            }
            
            // Add to user's cart with specified quality
            const userCart = getUserCart(userId);
            userCart.push({
                name: item.name,
                quality: quality || 'raw'
            });
            
            const qualityLabel = quality.charAt(0).toUpperCase() + quality.slice(1);
            
            await interaction.reply({
                content: `✅ Added **${item.name}** (${qualityLabel}) to your cart! Use \`/cart\` to view or submit.`,
                ephemeral: true
            });
        } else if (action === 'cart') {
            const subAction = rest[0];
            
            if (subAction === 'clear') {
                userCarts.set(userId, []);
                await interaction.reply({
                    content: '🗑️ Cart cleared!',
                    ephemeral: true
                });
            } else if (subAction === 'submit') {
                await interaction.reply({
                    content: 'Please use `/cart character:YourCharacterName` to submit your request.',
                    ephemeral: true
                });
            }
        }
    } catch (error) {
        console.error('Error handling button click:', error);
        await interaction.reply({
            content: 'An error occurred while processing your request.',
            ephemeral: true
        });
    }
}

async function showCart(interaction, userId) {
    const userCart = getUserCart(userId);
    
    if (userCart.length === 0) {
        await interaction.reply({
            content: '🛒 Your cart is empty! Use `/search` or `/banklist` to find items.',
            ephemeral: true
        });
        return;
    }
    
    const embed = new EmbedBuilder()
        .setTitle('🛒 Your Shopping Cart')
        .setColor(0x4CAF50)
        .setDescription(`You have ${userCart.length} item(s) in your cart:`)
        .setFooter({ text: 'Use /cart character:YourCharName to submit this request' });
    
    const cartItems = userCart.map((item, index) => 
        `${index + 1}. ${formatItemForRequest(item)}`
    ).join('\n');
    
    embed.addFields({
        name: 'Items in Cart',
        value: cartItems,
        inline: false
    });
    
    const buttons = createCartButtons(userId);
    
    await interaction.reply({
        embeds: [embed],
        components: [buttons],
        ephemeral: true
    });
}

async function submitCart(interaction, userId, characterName) {
    const userCart = getUserCart(userId);
    
    if (userCart.length === 0) {
        await interaction.reply({
            content: 'Your cart is empty! Add some items first.',
            ephemeral: true
        });
        return;
    }
    
    // Find bank requests channel
    const channel = interaction.guild.channels.cache.find(ch => 
        ch.name === config.bankChannelName || ch.name.includes('bank-request')
    );
    
    if (!channel) {
        await interaction.reply({
            content: 'Bank requests channel not found. Please contact an officer.',
            ephemeral: true
        });
        return;
    }
    
    // Generate unique request ID
    const requestId = requestIdCounter++;
    
    // Format the request
    const formattedItems = userCart.map(item => formatItemForRequest(item));
    
    // Store the request for officer management
    activeRequests.set(requestId, {
        id: requestId,
        userId: interaction.user.id,
        characterName: characterName,
        items: [...userCart], // Copy the cart
        requestedAt: new Date(),
        status: 'pending'
    });
    
    // Post to bank requests channel
    const requestEmbed = new EmbedBuilder()
        .setTitle(`🎒 Guild Bank Request #${requestId}`)
        .setColor(0x4CAF50)
        .addFields(
            { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Send to Character', value: characterName, inline: true },
            { name: 'Request ID', value: `#${requestId}`, inline: true },
            { name: 'Items Requested', value: formattedItems.join('\n'), inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Staff: Use /fulfill, /deny, or /partial commands with this ID' });
    
    // Create a new thread for this request
    const threadName = `Request #${requestId} - ${characterName}`;
    const requestMessage = await channel.send({ 
        embeds: [requestEmbed] 
    });
    
    // Create thread from the message
    const thread = await requestMessage.startThread({
        name: threadName,
        autoArchiveDuration: 1440, // Archive after 24 hours of inactivity
        reason: `Bank request #${requestId} by ${interaction.user.username}`
    });
    
    // Send a follow-up message in the thread for staff communication
    await thread.send(`**Request #${requestId} Thread**\n\nStaff can discuss this request here or use the following commands:\n\`/fulfill ${requestId}\`\n\`/deny ${requestId} reason:"..."\`\n\`/partial ${requestId} sent-items:"..." unavailable-items:"..."\``);
    
    // Store thread ID for potential updates
    activeRequests.get(requestId).messageId = requestMessage.id;
    activeRequests.get(requestId).threadId = thread.id;
    
    // Clear the user's cart
    userCarts.set(userId, []);
    
    await interaction.reply({
        content: `✅ Request #${requestId} submitted for **${userCart.length} items** to be sent to **${characterName}**!\n\nYour cart has been cleared.`,
        ephemeral: true
    });
}

async function handleOfficerCommand(interaction, commandType) {
    // Simple permission check - you can make this more sophisticated
    if (!interaction.member.permissions.has('ManageMessages')) {
        await interaction.reply({
            content: '❌ You need staff permissions to use this command.',
            ephemeral: true
        });
        return;
    }
    
    const requestId = interaction.options.getInteger('request-id');
    const request = activeRequests.get(requestId);
    
    if (!request) {
        await interaction.reply({
            content: `❌ Request #${requestId} not found. It may have already been processed.`,
            ephemeral: true
        });
        return;
    }
    
    const channel = interaction.guild.channels.cache.find(ch => 
        ch.name === config.bankChannelName || ch.name.includes('bank-request')
    );
    
    if (!channel) {
        await interaction.reply({
            content: 'Bank requests channel not found.',
            ephemeral: true
        });
        return;
    }
    
    try {
        switch (commandType) {
            case 'fulfill': {
                // Mark as fulfilled
                request.status = 'fulfilled';
                request.fulfilledBy = interaction.user.id;
                request.fulfilledAt = new Date();
                
                const fulfillEmbed = new EmbedBuilder()
                    .setTitle(`✅ Request #${requestId} Fulfilled`)
                    .setColor(0x4CAF50)
                    .addFields(
                        { name: 'Items Sent To', value: request.characterName, inline: true },
                        { name: 'Fulfilled By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Items', value: request.items.map(item => formatItemForRequest(item)).join('\n'), inline: false }
                    )
                    .setTimestamp();
                
                // Post fulfillment message in the thread if it exists
                if (request.threadId) {
                    try {
                        const thread = await interaction.guild.channels.fetch(request.threadId);
                        await thread.send(threadMessage);

            // Store thread info
            activeRequests.get(requestId).messageId = requestMessage.id;
            activeRequests.get(requestId).threadId = thread.id;

            // Reply to the user
            let replyMessage = `✅ Request #${requestId} submitted successfully!\n\n`;
            
            if (confirmedItems.length > 0) {
                replyMessage += `**✅ Confirmed items:** ${confirmedItems.length}\n`;
            }
            
            if (suggestedItems.length > 0) {
                replyMessage += `**⚠️ Suggested matches:** ${suggestedItems.length} (staff will verify)\n`;
            }
            
            if (needVerification.length > 0) {
                replyMessage += `**❓ Items to verify:** ${needVerification.length} (staff will check manually)\n`;
            }
            
            replyMessage += `\n**Send to:** ${characterName}`;
            
            if (notes) {
                replyMessage += `\n**Notes:** ${notes}`;
            }

            // Add tips for future requests
            if (suggestedItems.length > 0 || needVerification.length > 0) {
                replyMessage += `\n\n💡 **Tip:** Copy item names directly from the bank website for perfect matches!`;
            }

            await interaction.reply({
                content: replyMessage,
                ephemeral: true
            });

        } catch (error) {
            console.error('Error handling modal submit:', error);
            await interaction.reply({
                content: 'An error occurred while processing your request. Please try again.',
                ephemeral: true
            });
        }
    }
}

// Helper function to find items with fuzzy matching
function findItemInDatabase(searchTerm) {
    const searchKey = searchTerm.toLowerCase().trim();
    
    // Clean up common copy/paste artifacts from website
    const cleanedSearch = cleanCopiedText(searchKey);
    
    // 1. Try exact match first
    if (bankData.items.has(cleanedSearch)) {
        return {
            type: 'exact',
            item: bankData.items.get(cleanedSearch),
            confidence: 1.0
        };
    }
    
    // 2. Try exact match with original search
    if (bankData.items.has(searchKey)) {
        return {
            type: 'exact',
            item: bankData.items.get(searchKey),
            confidence: 1.0
        };
    }
    
    // 3. Try fuzzy matching
    let bestMatch = null;
    let highestScore = 0;
    const allMatches = [];
    
    for (const [key, item] of bankData.items) {
        // Calculate similarity scores
        const exactScore = key.includes(cleanedSearch) ? 0.9 : 0;
        const partialScore = getPartialMatchScore(cleanedSearch, key);
        const fuzzyScore = getFuzzyScore(cleanedSearch, key);
        
        const totalScore = Math.max(exactScore, partialScore, fuzzyScore);
        
        if (totalScore > 0.6) {
            allMatches.push({
                item: item,
                score: totalScore,
                matchType: exactScore > 0 ? 'partial' : 'fuzzy'
            });
        }
        
        if (totalScore > highestScore) {
            highestScore = totalScore;
            bestMatch = item;
        }
    }
    
    // Return results based on confidence
    if (highestScore > 0.8) {
        return {
            type: 'high_confidence',
            item: bestMatch,
            confidence: highestScore,
            alternatives: allMatches.slice(0, 3)
        };
    } else if (highestScore > 0.6) {
        return {
            type: 'suggestion',
            item: bestMatch,
            confidence: highestScore,
            alternatives: allMatches.slice(0, 3)
        };
    } else if (allMatches.length > 0) {
        return {
            type: 'low_confidence',
            item: null,
            confidence: 0,
            alternatives: allMatches.slice(0, 5)
        };
    }
    
    return null;
}

// Clean up text copied from website
function cleanCopiedText(text) {
    return text
        .replace(/\s+/g, ' ')                    // Multiple spaces to single
        .replace(/[^\w\s'-]/g, '')               // Remove special chars except apostrophes/hyphens
        .replace(/\b(raw|enchanted|legendary)\b/gi, '') // Remove quality indicators
        .replace(/\(\d+\)/g, '')                 // Remove count numbers like (2)
        .replace(/\s+/g, ' ')                    // Clean up spaces again
        .trim();
}

// Calculate partial match score
function getPartialMatchScore(search, target) {
    const searchWords = search.split(' ').filter(w => w.length > 2);
    const targetWords = target.split(' ');
    
    let matchedWords = 0;
    for (const searchWord of searchWords) {
        for (const targetWord of targetWords) {
            if (targetWord.includes(searchWord) || searchWord.includes(targetWord)) {
                matchedWords++;
                break;
            }
        }
    }
    
    return searchWords.length > 0 ? matchedWords / searchWords.length : 0;
}

// Calculate fuzzy similarity score (Levenshtein-based)
function getFuzzyScore(search, target) {
    if (search === target) return 1.0;
    if (search.length === 0 || target.length === 0) return 0;
    
    const maxLength = Math.max(search.length, target.length);
    const distance = levenshteinDistance(search, target);
    
    return 1 - (distance / maxLength);
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Start the bot
client.login(config.token);

// Export for potential module use
module.exports = { client, config };d({ embeds: [fulfillEmbed] });
                        
                        // Archive the thread since request is complete
                        await thread.setArchived(true, 'Request fulfilled');
                    } catch (error) {
                        console.log('Could not update thread, posting in main channel');
                        await channel.send({ embeds: [fulfillEmbed] });
                    }
                } else {
                    await channel.send({ embeds: [fulfillEmbed] });
                }
                
                // Notify the requester
                try {
                    const requester = await interaction.guild.members.fetch(request.userId);
                    await requester.send(`✅ Your bank request #${requestId} has been fulfilled! Items sent to **${request.characterName}**.`);
                } catch (error) {
                    console.log('Could not DM requester');
                }
                
                activeRequests.delete(requestId);
                
                await interaction.reply({
                    content: `✅ Request #${requestId} marked as fulfilled!`,
                    ephemeral: true
                });
                break;
            }
            
            case 'deny': {
                const reason = interaction.options.getString('reason');
                
                request.status = 'denied';
                request.deniedBy = interaction.user.id;
                request.deniedAt = new Date();
                request.deniedReason = reason;
                
                const denyEmbed = new EmbedBuilder()
                    .setTitle(`❌ Request #${requestId} Denied`)
                    .setColor(0xf44336)
                    .addFields(
                        { name: 'Requested By', value: `<@${request.userId}>`, inline: true },
                        { name: 'Denied By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Reason', value: reason, inline: false }
                    )
                    .setTimestamp();
                
                // Post denial message in the thread if it exists
                if (request.threadId) {
                    try {
                        const thread = await interaction.guild.channels.fetch(request.threadId);
                        await thread.send({ embeds: [denyEmbed] });
                        
                        // Archive the thread since request is denied
                        await thread.setArchived(true, 'Request denied');
                    } catch (error) {
                        console.log('Could not update thread, posting in main channel');
                        await channel.send({ embeds: [denyEmbed] });
                    }
                } else {
                    await channel.send({ embeds: [denyEmbed] });
                }
                
                // Notify the requester
                try {
                    const requester = await interaction.guild.members.fetch(request.userId);
                    await requester.send(`❌ Your bank request #${requestId} was denied.\n**Reason:** ${reason}\n\nFeel free to submit a new request!`);
                } catch (error) {
                    console.log('Could not DM requester');
                }
                
                activeRequests.delete(requestId);
                
                await interaction.reply({
                    content: `❌ Request #${requestId} denied. Requester has been notified.`,
                    ephemeral: true
                });
                break;
            }
            
            case 'partial': {
                const sentItems = interaction.options.getString('sent-items');
                const unavailableItems = interaction.options.getString('unavailable-items');
                
                request.status = 'partial';
                request.partialBy = interaction.user.id;
                request.partialAt = new Date();
                
                const partialEmbed = new EmbedBuilder()
                    .setTitle(`⚠️ Request #${requestId} Partially Fulfilled`)
                    .setColor(0xFF9800)
                    .addFields(
                        { name: 'Requested By', value: `<@${request.userId}>`, inline: true },
                        { name: 'Processed By', value: `<@${interaction.user.id}>`, inline: true },
                        { name: '✅ Items Sent', value: sentItems, inline: false },
                        { name: '❌ Unavailable Items', value: unavailableItems, inline: false }
                    )
                    .setTimestamp();
                
                // Post partial fulfillment message in the thread if it exists
                if (request.threadId) {
                    try {
                        const thread = await interaction.guild.channels.fetch(request.threadId);
                        await thread.send({ embeds: [partialEmbed] });
                        
                        // Archive the thread since request is processed
                        await thread.setArchived(true, 'Request partially fulfilled');
                    } catch (error) {
                        console.log('Could not update thread, posting in main channel');
                        await channel.send({ embeds: [partialEmbed] });
                    }
                } else {
                    await channel.send({ embeds: [partialEmbed] });
                }
                
                // Notify the requester
                try {
                    const requester = await interaction.guild.members.fetch(request.userId);
                    await requester.send(`⚠️ Your bank request #${requestId} was partially fulfilled.\n\n**Items Sent:** ${sentItems}\n**Unavailable:** ${unavailableItems}\n\nFeel free to request the unavailable items again later!`);
                } catch (error) {
                    console.log('Could not DM requester');
                }
                
                activeRequests.delete(requestId);
                
                await interaction.reply({
                    content: `⚠️ Request #${requestId} partially fulfilled. Requester has been notified.`,
                    ephemeral: true
                });
                break;
            }
        }
    } catch (error) {
        console.error('Error processing officer command:', error);
        await interaction.reply({
            content: 'An error occurred while processing the request.',
            ephemeral: true
        });
    }
}

async function handleModalSubmit(interaction) {
    if (interaction.customId.startsWith('requestModal_')) {
        const userId = interaction.customId.split('_')[1];
        
        // Only allow the user who opened the modal to submit it
        if (userId !== interaction.user.id) {
            await interaction.reply({
                content: 'You can only submit your own requests!',
                ephemeral: true
            });
            return;
        }

        try {
            // Get the form data
            const itemsText = interaction.fields.getTextInputValue('itemsInput');
            const characterName = interaction.fields.getTextInputValue('characterInput');
            const notes = interaction.fields.getTextInputValue('notesInput') || '';

            // Parse the items (one per line) with quality detection
            const requestedItems = itemsText
                .split('\n')
                .map(item => {
                    const trimmed = item.trim();
                    if (trimmed.length === 0) return null;
                    
                    // Check for quality specification in parentheses
                    const qualityMatch = trimmed.match(/^(.+?)\s*\((raw|enchanted|legendary)\)\s*$/i);
                    if (qualityMatch) {
                        return {
                            name: qualityMatch[1].trim(),
                            requestedQuality: qualityMatch[2].toLowerCase()
                        };
                    }
                    
                    // No quality specified = raw (tradeable)
                    return {
                        name: trimmed,
                        requestedQuality: 'raw'
                    };
                })
                .filter(item => item !== null);

            if (requestedItems.length === 0) {
                await interaction.reply({
                    content: 'Please enter at least one item to request.',
                    ephemeral: true
                });
                return;
            }

            // Validate and find items in the database
            const confirmedItems = [];
            const suggestedItems = [];
            const needVerification = [];

            for (const itemRequest of requestedItems) {
                const result = findItemInDatabase(itemRequest.name);
                
                if (!result) {
                    needVerification.push({
                        original: `${itemRequest.name} (${itemRequest.requestedQuality})`,
                        reason: 'No matches found'
                    });
                } else if (result.type === 'exact' || result.type === 'high_confidence') {
                    // Check if requested quality is available
                    const availableQualities = getAvailableQualities(result.item);
                    if (availableQualities.includes(itemRequest.requestedQuality)) {
                        confirmedItems.push({
                            name: result.item.name,
                            quality: itemRequest.requestedQuality,
                            original: itemRequest.name !== result.item.name.toLowerCase() ? itemRequest.name : null
                        });
                    } else {
                        needVerification.push({
                            original: `${itemRequest.name} (${itemRequest.requestedQuality})`,
                            reason: `${itemRequest.requestedQuality} quality not available`,
                            availableQualities: availableQualities
                        });
                    }
                } else if (result.type === 'suggestion') {
                    suggestedItems.push({
                        original: `${itemRequest.name} (${itemRequest.requestedQuality})`,
                        suggested: result.item.name,
                        requestedQuality: itemRequest.requestedQuality,
                        confidence: result.confidence,
                        alternatives: result.alternatives
                    });
                } else {
                    needVerification.push({
                        original: `${itemRequest.name} (${itemRequest.requestedQuality})`,
                        reason: 'Low confidence match',
                        alternatives: result.alternatives
                    });
                }
            }

            // Generate unique request ID
            const requestId = requestIdCounter++;

            // Create the request object
            const request = {
                id: requestId,
                userId: interaction.user.id,
                characterName: characterName,
                confirmedItems: confirmedItems,
                suggestedItems: suggestedItems,
                needVerification: needVerification,
                notes: notes,
                requestedAt: new Date(),
                status: 'pending'
            };

            // Store the request
            activeRequests.set(requestId, request);

            // Find bank requests channel
            const channel = interaction.guild.channels.cache.find(ch => 
                ch.name === config.bankChannelName || ch.name.includes('bank-request')
            );

            if (!channel) {
                await interaction.reply({
                    content: 'Bank requests channel not found. Please contact staff.',
                    ephemeral: true
                });
                return;
            }

            // Determine embed color based on request status
            let embedColor = 0x4CAF50; // Green - all good
            if (suggestedItems.length > 0 || needVerification.length > 0) {
                embedColor = 0xFF9800; // Orange - needs attention
            }

            // Create the request embed
            const requestEmbed = new EmbedBuilder()
                .setTitle(`🎒 Guild Bank Request #${requestId}`)
                .setColor(embedColor)
                .addFields(
                    { name: 'Requested by', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Send to Character', value: characterName, inline: true },
                    { name: 'Request ID', value: `#${requestId}`, inline: true }
                )
                .setTimestamp()
                .setFooter({ text: 'Staff: Use /fulfill, /deny, or /partial commands with this ID' });

            // Add confirmed items
            if (confirmedItems.length > 0) {
                const confirmedText = confirmedItems.map(item => {
                    let text = formatItemForRequest(item);
                    if (item.original) {
                        text += ` *(typed: "${item.original}")*`;
                    }
                    return text;
                }).join('\n');
                
                requestEmbed.addFields({
                    name: '✅ Confirmed Items (In Stock)',
                    value: confirmedText,
                    inline: false
                });
            }

            // Add suggested items
            if (suggestedItems.length > 0) {
                const suggestedText = suggestedItems.map(item => {
                    return `"${item.original}" → **${item.suggested}** *(${Math.round(item.confidence * 100)}% match)*`;
                }).join('\n');
                
                requestEmbed.addFields({
                    name: '⚠️ Suggested Matches (Please Verify)',
                    value: suggestedText + '\n\n*Staff: Confirm these are correct before fulfilling*',
                    inline: false
                });
            }

            // Add items needing verification
            if (needVerification.length > 0) {
                const verificationText = needVerification.map(item => {
                    let text = `"${item.original}" - ${item.reason}`;
                    if (item.availableQualities && item.availableQualities.length > 0) {
                        text += `\n  *Available: ${item.availableQualities.join(', ')} quality*`;
                    }
                    return text;
                }).join('\n');
                
                requestEmbed.addFields({
                    name: '❓ Need Manual Verification',
                    value: verificationText + '\n\n*Staff: Please check bank for these items*',
                    inline: false
                });
            }

            // Add notes if provided
            if (notes) {
                requestEmbed.addFields({
                    name: '📝 Additional Notes',
                    value: notes,
                    inline: false
                });
            }

            // Create a new thread for this request
            const threadName = `Request #${requestId} - ${characterName}`;
            const requestMessage = await channel.send({ 
                embeds: [requestEmbed] 
            });

            // Create thread from the message
            const thread = await requestMessage.startThread({
                name: threadName,
                autoArchiveDuration: 1440, // Archive after 24 hours of inactivity
                reason: `Bank request #${requestId} by ${interaction.user.username}`
            });

            // Send thread instructions
            let threadMessage = `**Request #${requestId} Thread**\n\nStaff commands:\n\`/fulfill ${requestId}\`\n\`/deny ${requestId} reason:"..."\`\n\`/partial ${requestId} sent-items:"..." unavailable-items:"..."\``;
            
            if (suggestedItems.length > 0) {
                threadMessage += `\n\n⚠️ **Suggested matches to verify:**`;
                suggestedItems.forEach(item => {
                    threadMessage += `\n• "${item.original}" → ${item.suggested}`;
                });
            }
            
            if (needVerification.length > 0) {
                threadMessage += `\n\n❓ **Items to manually check:**`;
                needVerification.forEach(item => {
                    threadMessage += `\n• "${item.original}"`;
                });
            }

            await thread.sen
