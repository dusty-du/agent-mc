package io.agentmc.resident;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;
import net.kyori.adventure.text.Component;
import org.bukkit.Color;
import org.bukkit.entity.Display;
import org.bukkit.entity.Player;
import org.bukkit.entity.TextDisplay;
import org.bukkit.scheduler.BukkitTask;

public final class ResidentThoughtBubbleService {
    private static final long DEFAULT_POLL_INTERVAL_TICKS = 10L;
    private static final double DEFAULT_BUBBLE_OFFSET_Y = 2.6D;

    private final ResidentPlugin plugin;
    private final BrainClient brainClient;
    private final AtomicBoolean requestInFlight = new AtomicBoolean(false);

    private BukkitTask pollTask;
    private BukkitTask followTask;
    private TextDisplay display;
    private BrainClient.ResidentPresentationThought activeThought;

    public ResidentThoughtBubbleService(ResidentPlugin plugin, BrainClient brainClient) {
        this.plugin = plugin;
        this.brainClient = brainClient;
    }

    public void start() {
        long pollInterval = Math.max(1L, plugin.getConfig().getLong("resident.thought-bubble-poll-ticks", DEFAULT_POLL_INTERVAL_TICKS));

        pollTask = plugin.getServer().getScheduler().runTaskTimerAsynchronously(
            plugin,
            this::pollPresentation,
            0L,
            pollInterval
        );
        followTask = plugin.getServer().getScheduler().runTaskTimer(plugin, this::syncBubblePosition, 0L, 1L);
    }

    public void stop() {
        if (pollTask != null) {
            pollTask.cancel();
            pollTask = null;
        }
        if (followTask != null) {
            followTask.cancel();
            followTask = null;
        }
        clearBubble();
    }

    private void pollPresentation() {
        if (!requestInFlight.compareAndSet(false, true)) {
            return;
        }

        brainClient.fetchResidentPresentation()
            .thenAccept(snapshot -> plugin.getServer().getScheduler().runTask(plugin, () -> applyPresentation(snapshot)))
            .whenComplete((ignored, error) -> requestInFlight.set(false));
    }

    private void applyPresentation(BrainClient.ResidentPresentationSnapshot snapshot) {
        BrainClient.ResidentPresentationThought thought = snapshot.thought();
        if (thought == null || isExpired(thought.expiresAt())) {
            activeThought = null;
            clearBubble();
            return;
        }

        activeThought = thought;
        Player resident = plugin.residentPlayer();
        if (resident == null || !resident.isOnline()) {
            clearBubble();
            return;
        }

        ensureBubble(resident);
        if (display != null) {
            display.setText(thought.text());
        }
        syncBubblePosition();
    }

    private void ensureBubble(Player resident) {
        if (display != null && display.isValid()) {
            return;
        }

        display = resident.getWorld().spawn(resident.getLocation().add(0.0D, bubbleOffsetY(), 0.0D), TextDisplay.class, entity -> {
            entity.setBillboard(Display.Billboard.CENTER);
            entity.setPersistent(false);
            entity.setShadowed(true);
            entity.setSeeThrough(false);
            entity.setBackgroundColor(Color.fromARGB(220, 246, 239, 224));
            entity.setDefaultBackground(false);
            entity.setLineWidth(220);
            entity.setTextOpacity((byte) 255);
            entity.text(Component.text(""));
        });
    }

    private void syncBubblePosition() {
        if (display == null) {
            return;
        }

        Player resident = plugin.residentPlayer();
        if (resident == null || !resident.isOnline() || activeThought == null || isExpired(activeThought.expiresAt())) {
            activeThought = null;
            clearBubble();
            return;
        }

        display.teleport(resident.getLocation().add(0.0D, bubbleOffsetY(), 0.0D));
    }

    private void clearBubble() {
        if (display != null) {
            display.remove();
            display = null;
        }
    }

    private boolean isExpired(String expiresAt) {
        try {
            return Instant.parse(expiresAt).isBefore(Instant.now());
        } catch (Exception error) {
            return true;
        }
    }

    private double bubbleOffsetY() {
        return plugin.getConfig().getDouble("resident.thought-bubble-offset-y", DEFAULT_BUBBLE_OFFSET_Y);
    }
}
