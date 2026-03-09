package io.agentmc.resident;

import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Player;

public final class ProtectedAreaCommand implements CommandExecutor, TabCompleter {
    private final ProtectedAreaManager protectedAreaManager;
    private final BrainClient brainClient;

    public ProtectedAreaCommand(ProtectedAreaManager protectedAreaManager, BrainClient brainClient) {
        this.protectedAreaManager = protectedAreaManager;
        this.brainClient = brainClient;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(Component.text(
                "Usage: /" + label + " <add|remove|list> ...",
                NamedTextColor.RED
            ));
            return true;
        }

        return switch (args[0].toLowerCase(Locale.ROOT)) {
            case "list" -> handleList(sender);
            case "add" -> handleAdd(sender, label, args);
            case "remove" -> handleRemove(sender, label, args);
            default -> {
                sender.sendMessage(Component.text("Unknown subcommand.", NamedTextColor.RED));
                yield true;
            }
        };
    }

    private boolean handleList(CommandSender sender) {
        if (protectedAreaManager.all().isEmpty()) {
            sender.sendMessage(Component.text("No protected areas are configured.", NamedTextColor.YELLOW));
            return true;
        }

        sender.sendMessage(Component.text("Protected areas:", NamedTextColor.GOLD));
        for (ProtectedArea area : protectedAreaManager.all()) {
            sender.sendMessage(Component.text(
                "- " + area.id() + " (" + area.label() + ") in " + area.world() + " radius " + area.radius(),
                NamedTextColor.GRAY
            ));
        }
        return true;
    }

    private boolean handleAdd(CommandSender sender, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("Only a player can add a protected area from their position.", NamedTextColor.RED));
            return true;
        }

        if (args.length < 3) {
            sender.sendMessage(Component.text(
                "Usage: /" + label + " add <id> <radius> [label...]",
                NamedTextColor.RED
            ));
            return true;
        }

        double radius;
        try {
            radius = Double.parseDouble(args[2]);
        } catch (NumberFormatException exception) {
            sender.sendMessage(Component.text("Radius must be a number.", NamedTextColor.RED));
            return true;
        }

        String areaLabel = args.length > 3
            ? String.join(" ", java.util.Arrays.copyOfRange(args, 3, args.length))
            : args[1];
        ProtectedArea area = protectedAreaManager.save(args[1], areaLabel, player.getLocation(), radius, player.getName());
        brainClient.postProtectedAreaSnapshot(protectedAreaManager.all(), "add");
        sender.sendMessage(Component.text(
            "Protected area " + area.id() + " saved at your current position.",
            NamedTextColor.GREEN
        ));
        return true;
    }

    private boolean handleRemove(CommandSender sender, String label, String[] args) {
        if (args.length < 2) {
            sender.sendMessage(Component.text("Usage: /" + label + " remove <id>", NamedTextColor.RED));
            return true;
        }

        boolean removed = protectedAreaManager.remove(args[1]);
        if (removed) {
            brainClient.postProtectedAreaSnapshot(protectedAreaManager.all(), "remove");
            sender.sendMessage(Component.text("Removed protected area " + args[1] + ".", NamedTextColor.GREEN));
        } else {
            sender.sendMessage(Component.text("No protected area found with id " + args[1] + ".", NamedTextColor.RED));
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) {
            return Stream.of("add", "remove", "list")
                .filter(option -> startsWithIgnoreCase(option, args[0]))
                .toList();
        }

        if (args.length == 2 && args[0].equalsIgnoreCase("remove")) {
            return protectedAreaManager.all().stream()
                .map(ProtectedArea::id)
                .filter(id -> startsWithIgnoreCase(id, args[1]))
                .sorted()
                .toList();
        }

        return List.of();
    }

    private static boolean startsWithIgnoreCase(String candidate, String prefix) {
        return candidate.toLowerCase(Locale.ROOT).startsWith(prefix.toLowerCase(Locale.ROOT));
    }
}
