package io.agentmc.resident;

import java.util.List;
import java.util.Locale;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

public final class ResidentStatusCommand implements CommandExecutor, TabCompleter {
    private static final List<String> STATUS_SUGGESTIONS = List.of(
        "online",
        "away",
        "busy",
        "building",
        "exploring",
        "offline"
    );

    private final ResidentPlugin plugin;
    private final BrainClient brainClient;

    public ResidentStatusCommand(ResidentPlugin plugin, BrainClient brainClient) {
        this.plugin = plugin;
        this.brainClient = brainClient;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(Component.text("Usage: /" + label + " <status...>", NamedTextColor.RED));
            return true;
        }

        Player target;
        int statusStartIndex = 0;

        if (sender instanceof Player player) {
            target = player;
        } else {
            if (args.length < 2) {
                sender.sendMessage(Component.text("Usage: /" + label + " <player> <status...>", NamedTextColor.RED));
                return true;
            }

            target = Bukkit.getPlayerExact(args[0]);
            if (target == null) {
                sender.sendMessage(Component.text("That player is not online.", NamedTextColor.RED));
                return true;
            }

            statusStartIndex = 1;
        }

        String status = String.join(" ", java.util.Arrays.copyOfRange(args, statusStartIndex, args.length)).trim();
        if (status.isEmpty()) {
            sender.sendMessage(Component.text("Status cannot be empty.", NamedTextColor.RED));
            return true;
        }

        brainClient.postResidentStatus(target, status, "command")
            .thenAccept(success -> plugin.getServer().getScheduler().runTask(plugin, () -> {
                if (success) {
                    sender.sendMessage(Component.text(
                        "Posted resident status for " + target.getName() + ".",
                        NamedTextColor.GREEN
                    ));
                } else {
                    sender.sendMessage(Component.text(
                        "Failed to post resident status to the local brain endpoint.",
                        NamedTextColor.RED
                    ));
                }
            }));

        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (!(sender instanceof Player)) {
            if (args.length == 1) {
                return Bukkit.getOnlinePlayers().stream()
                    .map(Player::getName)
                    .filter(name -> startsWithIgnoreCase(name, args[0]))
                    .sorted()
                    .toList();
            }

            if (args.length == 2) {
                return STATUS_SUGGESTIONS.stream()
                    .filter(status -> startsWithIgnoreCase(status, args[1]))
                    .toList();
            }
        }

        if (sender instanceof Player && args.length == 1) {
            return STATUS_SUGGESTIONS.stream()
                .filter(status -> startsWithIgnoreCase(status, args[0]))
                .toList();
        }

        return List.of();
    }

    private static boolean startsWithIgnoreCase(String candidate, String prefix) {
        return candidate.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT));
    }
}
