package io.agentmc.resident;

import io.papermc.paper.event.player.AsyncChatEvent;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;
import org.bukkit.event.weather.WeatherChangeEvent;

public final class ResidentBrainBridgeListener implements Listener {
    private static final double DEFAULT_CHAT_RADIUS = 48.0D;

    private final ResidentPlugin plugin;
    private final BrainClient brainClient;

    public ResidentBrainBridgeListener(ResidentPlugin plugin, BrainClient brainClient) {
        this.plugin = plugin;
        this.brainClient = brainClient;
    }

    @EventHandler(ignoreCancelled = true)
    public void onResidentBedEnter(PlayerBedEnterEvent event) {
        if (!plugin.isResidentPlayer(event.getPlayer())) {
            return;
        }

        brainClient.postResidentBedEvent(event.getPlayer(), event.getBedEnterResult());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onResidentDeath(PlayerDeathEvent event) {
        if (!plugin.isResidentPlayer(event.getPlayer())) {
            return;
        }

        String deathMessage = event.deathMessage() == null
            ? ""
            : PlainTextComponentSerializer.plainText().serialize(event.deathMessage());
        brainClient.postResidentDeath(event.getPlayer(), deathMessage);
    }

    @EventHandler(ignoreCancelled = true)
    public void onPlayerChat(AsyncChatEvent event) {
        String message = PlainTextComponentSerializer.plainText().serialize(event.message()).trim();
        if (message.isEmpty()) {
            return;
        }

        Player speaker = event.getPlayer();
        plugin.getServer().getScheduler().runTask(plugin, () -> {
            Player resident = plugin.residentPlayer();
            boolean speakerIsResident = plugin.isResidentPlayer(speaker);
            boolean nearResident = speakerIsResident || isNearResident(speaker, resident);
            if (!nearResident) {
                return;
            }

            brainClient.postPlayerChat(speaker, message, nearResident);
        });
    }

    @EventHandler(ignoreCancelled = true)
    public void onWeatherChange(WeatherChangeEvent event) {
        Player resident = plugin.residentPlayer();
        if (resident == null || !resident.isOnline() || !resident.getWorld().equals(event.getWorld())) {
            return;
        }

        brainClient.postWorldWeather(event.getWorld(), event.toWeatherState());
    }

    private boolean isNearResident(Player speaker, Player resident) {
        if (resident == null || !resident.isOnline()) {
            return false;
        }

        if (!speaker.getWorld().equals(resident.getWorld())) {
            return false;
        }

        double radius = Math.max(1.0D, plugin.getConfig().getDouble("brain.player-chat-radius", DEFAULT_CHAT_RADIUS));
        return speaker.getLocation().distanceSquared(resident.getLocation()) <= radius * radius;
    }
}
