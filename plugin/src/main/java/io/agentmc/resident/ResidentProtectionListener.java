package io.agentmc.resident;

import java.util.Optional;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;

public final class ResidentProtectionListener implements Listener {
    private final ResidentPlugin plugin;
    private final BrainClient brainClient;
    private final ProtectedAreaManager protectedAreaManager;

    public ResidentProtectionListener(
        ResidentPlugin plugin,
        BrainClient brainClient,
        ProtectedAreaManager protectedAreaManager
    ) {
        this.plugin = plugin;
        this.brainClient = brainClient;
        this.protectedAreaManager = protectedAreaManager;
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        handleProtectedAction(event.getPlayer(), event.getBlock().getLocation(), "break", event);
    }

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        handleProtectedAction(event.getPlayer(), event.getBlock().getLocation(), "place", event);
    }

    private void handleProtectedAction(Player player, org.bukkit.Location location, String action, org.bukkit.event.Cancellable event) {
        if (!plugin.isResidentPlayer(player)) {
            return;
        }

        Optional<ProtectedArea> protectedArea = protectedAreaManager.findContaining(location);
        if (protectedArea.isEmpty()) {
            return;
        }

        event.setCancelled(true);
        ProtectedArea area = protectedArea.get();
        player.sendMessage(Component.text(
            "This area is protected: " + area.label(),
            NamedTextColor.RED
        ));
        brainClient.postProtectedAreaConflict(player, area, action);
    }
}
