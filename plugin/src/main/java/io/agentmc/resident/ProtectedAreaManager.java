package io.agentmc.resident;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.bukkit.Location;
import org.bukkit.configuration.ConfigurationSection;

public final class ProtectedAreaManager {
    private final ResidentPlugin plugin;
    private final Map<String, ProtectedArea> areas = new LinkedHashMap<>();

    public ProtectedAreaManager(ResidentPlugin plugin) {
        this.plugin = plugin;
        reload();
    }

    public void reload() {
        areas.clear();
        ConfigurationSection root = plugin.getConfig().getConfigurationSection("protected-areas");
        if (root == null) {
            return;
        }

        for (String key : root.getKeys(false)) {
            ConfigurationSection section = root.getConfigurationSection(key);
            if (section == null) {
                continue;
            }
            areas.put(key.toLowerCase(), ProtectedArea.fromConfig(key, section));
        }
    }

    public Collection<ProtectedArea> all() {
        return areas.values();
    }

    public Optional<ProtectedArea> findContaining(Location location) {
        return areas.values().stream().filter(area -> area.contains(location)).findFirst();
    }

    public Optional<ProtectedArea> findById(String id) {
        return Optional.ofNullable(areas.get(id.toLowerCase()));
    }

    public ProtectedArea save(String id, String label, Location center, double radius, String owner) {
        ProtectedArea area = new ProtectedArea(
            id,
            label,
            center.getWorld().getName(),
            center.getX(),
            center.getY(),
            center.getZ(),
            Math.max(1.0D, radius),
            owner
        );
        areas.put(id.toLowerCase(), area);
        persist();
        return area;
    }

    public boolean remove(String id) {
        ProtectedArea removed = areas.remove(id.toLowerCase());
        if (removed == null) {
            return false;
        }
        persist();
        return true;
    }

    private void persist() {
        plugin.getConfig().set("protected-areas", null);
        ConfigurationSection root = plugin.getConfig().createSection("protected-areas");
        for (ProtectedArea area : areas.values()) {
            ConfigurationSection section = root.createSection(area.id());
            area.writeTo(section);
        }
        plugin.saveConfig();
    }
}
