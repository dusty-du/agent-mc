package io.agentmc.resident;

import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

public final class ResidentStatusListener implements Listener {
    private final ResidentPlugin plugin;
    private final BrainClient brainClient;

    public ResidentStatusListener(ResidentPlugin plugin, BrainClient brainClient) {
        this.plugin = plugin;
        this.brainClient = brainClient;
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        if (!plugin.isResidentPlayer(event.getPlayer())) {
            return;
        }

        brainClient.postResidentStatus(event.getPlayer(), "online", "join-hook");
    }

    @EventHandler
    public void onPlayerQuit(PlayerQuitEvent event) {
        if (!plugin.isResidentPlayer(event.getPlayer())) {
            return;
        }

        brainClient.postResidentStatus(event.getPlayer(), "offline", "quit-hook");
    }
}
