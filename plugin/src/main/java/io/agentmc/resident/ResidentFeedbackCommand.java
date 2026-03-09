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

public final class ResidentFeedbackCommand implements CommandExecutor, TabCompleter {
    private final ResidentPlugin plugin;
    private final BrainClient brainClient;

    public ResidentFeedbackCommand(ResidentPlugin plugin, BrainClient brainClient) {
        this.plugin = plugin;
        this.brainClient = brainClient;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(Component.text("Usage: /" + label + " <message...>", NamedTextColor.RED));
            return true;
        }

        Player target;
        int messageStartIndex = 0;

        if (sender instanceof Player player) {
            target = player;
        } else {
            if (args.length < 2) {
                sender.sendMessage(Component.text("Usage: /" + label + " <player> <message...>", NamedTextColor.RED));
                return true;
            }

            target = Bukkit.getPlayerExact(args[0]);
            if (target == null) {
                sender.sendMessage(Component.text("That player is not online.", NamedTextColor.RED));
                return true;
            }

            messageStartIndex = 1;
        }

        String message = String.join(" ", java.util.Arrays.copyOfRange(args, messageStartIndex, args.length)).trim();
        if (message.isEmpty()) {
            sender.sendMessage(Component.text("Feedback cannot be empty.", NamedTextColor.RED));
            return true;
        }

        brainClient.postPlayerFeedback(target, message)
            .thenAccept(success -> plugin.getServer().getScheduler().runTask(plugin, () -> {
                if (success) {
                    sender.sendMessage(Component.text(
                        "Posted feedback for " + target.getName() + ".",
                        NamedTextColor.GREEN
                    ));
                } else {
                    sender.sendMessage(Component.text(
                        "Failed to post feedback to the local brain endpoint.",
                        NamedTextColor.RED
                    ));
                }
            }));

        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (!(sender instanceof Player) && args.length == 1) {
            return Bukkit.getOnlinePlayers().stream()
                .map(Player::getName)
                .filter(name -> startsWithIgnoreCase(name, args[0]))
                .sorted()
                .toList();
        }

        return List.of();
    }

    private static boolean startsWithIgnoreCase(String candidate, String prefix) {
        return candidate.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT));
    }
}
