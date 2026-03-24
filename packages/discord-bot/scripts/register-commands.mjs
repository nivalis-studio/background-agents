const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  throw new Error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required");
}

const commands = [
  {
    name: "inspect",
    description: "Run Open-Inspect against a repository",
    options: [
      {
        type: 3,
        name: "prompt",
        description: "What should the agent do?",
        required: true,
      },
      {
        type: 3,
        name: "repo",
        description: "Optional owner/name repository override",
        required: false,
      },
    ],
  },
  {
    name: "inspect-settings",
    description: "Configure your preferred Open-Inspect model and reasoning effort",
  },
];

const path = guildId
  ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${applicationId}/commands`;

const response = await fetch(path, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Failed to register Discord commands: ${response.status} ${body}`);
}

console.log("Discord commands registered successfully");
