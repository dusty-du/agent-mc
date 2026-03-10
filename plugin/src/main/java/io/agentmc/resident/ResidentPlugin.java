package io.agentmc.resident;

import org.bukkit.command.CommandExecutor;
import org.bukkit.command.PluginCommand;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

public final class ResidentPlugin extends JavaPlugin {
    private BrainClient brainClient;
    private ProtectedAreaManager protectedAreaManager;
    private ResidentThoughtBubbleService thoughtBubbleService;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        try {
            this.brainClient = new BrainClient(this);
        } catch (IllegalArgumentException exception) {
            getLogger().severe("Invalid brain endpoint configuration: " + exception.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        this.protectedAreaManager = new ProtectedAreaManager(this);
        ResidentStatusCommand residentStatusCommand = new ResidentStatusCommand(this, brainClient);
        ResidentFeedbackCommand residentFeedbackCommand = new ResidentFeedbackCommand(this, brainClient);
        ProtectedAreaCommand protectedAreaCommand = new ProtectedAreaCommand(protectedAreaManager, brainClient);

        registerCommand("residentstatus", residentStatusCommand, residentStatusCommand);
        registerCommand("residentfeedback", residentFeedbackCommand, residentFeedbackCommand);
        registerCommand("residentprotect", protectedAreaCommand, protectedAreaCommand);
        getServer().getPluginManager().registerEvents(new ResidentStatusListener(this, brainClient), this);
        getServer().getPluginManager().registerEvents(new ResidentBrainBridgeListener(this, brainClient), this);
        getServer().getPluginManager().registerEvents(
            new ResidentProtectionListener(this, brainClient, protectedAreaManager),
            this
        );

        brainClient.postProtectedAreaSnapshot(protectedAreaManager.all(), "startup");
        this.thoughtBubbleService = new ResidentThoughtBubbleService(this, brainClient);
        this.thoughtBubbleService.start();

        getLogger().info("Resident plugin enabled; posting to " + brainClient.endpoint());
    }

    @Override
    public void onDisable() {
        if (thoughtBubbleService != null) {
            thoughtBubbleService.stop();
        }
    }

    public boolean isResidentPlayer(org.bukkit.entity.Player player) {
        String residentUsername = residentUsername();
        return !residentUsername.isBlank() && residentUsername.equalsIgnoreCase(player.getName());
    }

    public String residentUsername() {
        return getConfig().getString("resident.username", "").trim();
    }

    public Player residentPlayer() {
        String residentUsername = residentUsername();
        if (residentUsername.isBlank()) {
            return null;
        }

        return getServer().getPlayerExact(residentUsername);
    }

    private void registerCommand(String name, CommandExecutor executor, TabCompleter completer) {
        PluginCommand command = getCommand(name);
        if (command == null) {
            throw new IllegalStateException("Command not defined in plugin.yml: " + name);
        }

        command.setExecutor(executor);
        command.setTabCompleter(completer);
    }
}
