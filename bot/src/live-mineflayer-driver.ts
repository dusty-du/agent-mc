import { setTimeout as delay } from "node:timers/promises";
import { Bot, createBot } from "mineflayer";
import { ActionReport, AgentIntent, BuildPlan, COMBAT_ENGAGE_DISTANCE, CraftGoal, PerceptionFrame, SiteArea, Vec3, WeatherState } from "@resident/shared";
import { IntentExecutionContext } from "./resident-bot";

type GoalNearCtor = new (x: number, y: number, z: number, range: number) => unknown;
type BotBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type BotBlockMaybe = ReturnType<Bot["blockAt"]>;
type BotItem = ReturnType<Bot["inventory"]["items"]>[number];
type BotEntity = Bot["entities"][number];

export interface LiveMineflayerDriverConfig {
  host: string;
  port: number;
  username: string;
  version?: string;
  auth?: "offline" | "microsoft";
  viewerPort?: number;
}

export class LiveMineflayerDriver {
  private bot?: Bot;
  private GoalNear?: GoalNearCtor;

  constructor(private readonly config: LiveMineflayerDriverConfig) {}

  async connect(): Promise<Bot> {
    const bot = createBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      version: this.config.version,
      auth: this.config.auth ?? "offline"
    });

    const pathfinderModule = require("mineflayer-pathfinder");
    const collectBlockModule = require("mineflayer-collectblock");

    bot.loadPlugin(pathfinderModule.pathfinder);
    bot.loadPlugin(collectBlockModule.plugin);
    this.GoalNear = pathfinderModule.goals.GoalNear as GoalNearCtor;

    await onceSpawn(bot);

    if (this.config.viewerPort) {
      const viewerModule = require("prismarine-viewer");
      viewerModule.mineflayer(bot, {
        port: this.config.viewerPort,
        firstPerson: false
      });
    }
    this.bot = bot;
    return bot;
  }

  async collectPerception(): Promise<PerceptionFrame> {
    const bot = this.requireBot();
    const homeAnchor = resolveHomeAnchor(bot);
    const standingBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    const inventory = bot.inventory.items().reduce<Record<string, number>>((acc, item) => {
      acc[item.name] = (acc[item.name] ?? 0) + item.count;
      return acc;
    }, {});

    const nearbyEntities = Object.values(bot.entities)
      .filter((entity): entity is BotEntity => Boolean(entity?.position) && entity.id !== bot.entity.id && bot.entity.position.distanceTo(entity.position) <= 24)
      .map((entity) => ({
        id: String(entity.id),
        name: entity.username ?? entity.name ?? entity.displayName ?? "unknown",
        type: inferEntityType(entity.username ?? entity.name ?? "", entity.type),
        distance: bot.entity.position.distanceTo(entity.position),
        position: toSharedVec(entity.position),
        isBaby: Boolean((entity.metadata ?? []).some((entry: unknown) => entry === true)),
        isAggressive: inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "hostile"
      }));

    const nearbyBlocks = bot.findBlocks({
      matching: (block: { name: string }) => !String(block.name).includes("air"),
      maxDistance: 10,
      count: 40
    })
      .map((position) => bot.blockAt(position))
      .filter((block): block is BotBlock => Boolean(block))
      .filter((block) => !block.name.includes("air"))
      .map((block) => ({
        name: block.name,
        position: toSharedVec(block.position),
        distance: bot.entity.position.distanceTo(block.position),
        harvestable: !block.name.includes("bedrock"),
        safeToRemove: !block.name.includes("bedrock") && !block.name.includes("obsidian")
      }));

    const cropSites = nearbyBlocks
      .filter((block) => cropNames.includes(block.name))
      .map((block) => {
        const cropBlock = bot.blockAt(toVec3(block.position));
        return {
          crop: block.name,
          location: block.position,
          stage: cropStage(cropBlock),
          irrigated: hasAdjacentWater(bot, toVec3(block.position).offset(0, -1, 0), 4)
        };
      });

    const terrainAffordances = inferTerrainAffordances(bot, nearbyBlocks);
    const storageSites = nearbyBlocks
      .filter((block) => block.name.includes("chest") || block.name.includes("barrel"))
      .map((block, index) => ({
        label: `${block.name}-${index + 1}`,
        location: block.position,
        contents: {}
      }));
    const nearbyBedCount = bot.findBlocks({
      matching: (block: { name: string }) => block.name.includes("bed"),
      maxDistance: 12,
      count: 8
    }).length;
    const nearestShelter = homeAnchor ?? nearestNamedBlock(bot, ["door", "crafting_table", "chest", "furnace"]);
    const notablePlaces = inferNotablePlaces(nearbyBlocks, nearbyEntities, terrainAffordances);

    return {
      agent_id: bot.username,
      tick_time: bot.time.time ?? bot.time.timeOfDay ?? 0,
      position: toSharedVec(bot.entity.position),
      biome: bot.game.dimension,
      weather: inferWeather(bot),
      light_level: inferLightLevel(standingBlock),
      health: bot.health,
      hunger: bot.food,
      inventory,
      equipped_item: bot.heldItem?.name,
      nearby_entities: nearbyEntities,
      nearby_blocks: nearbyBlocks,
      home_state: {
        anchor: homeAnchor ?? undefined,
        shelterScore: inferShelterScore(nearbyBlocks),
        bedAvailable: Boolean(bot.findBlock({ matching: (block: { name: string }) => block.name.includes("bed"), maxDistance: 12 })),
        workshopReady: Boolean(bot.findBlock({ matching: byBlockName(bot, "crafting_table"), maxDistance: 12 })),
        guestCapacity: Math.max(0, nearbyBedCount - 1)
      },
      snapshot_refs: [],
      notable_places: notablePlaces,
      pantry_state: {
        carriedCalories: estimateInventoryCalories(inventory),
        pantryCalories: 0,
        cookedMeals: countFood(inventory, cookedFoods),
        cropReadiness: cropSites.length > 0 ? cropSites.filter((site) => site.stage === "ripe").length / cropSites.length : 0,
        emergencyReserveDays: estimateReserveDays(bot.food, inventory)
      },
      farm_state: {
        farmlandReady: Boolean(bot.findBlock({ matching: byBlockName(bot, "farmland"), maxDistance: 12 })),
        plantedCrops: cropSites.map((site) => site.crop),
        hydratedTiles: nearbyBlocks.filter((block) => block.name === "farmland" && hasAdjacentWater(bot, toVec3(block.position), 4)).length,
        harvestableTiles: cropSites.filter((site) => site.stage === "ripe").length,
        seedStock: {
          wheat_seeds: inventory.wheat_seeds ?? 0,
          beetroot_seeds: inventory.beetroot_seeds ?? 0,
          carrot: inventory.carrot ?? 0,
          potato: inventory.potato ?? 0
        }
      },
      livestock_state: {
        counts: countLivestock(nearbyEntities),
        targetRanges: {
          chicken: { min: 2, max: 8 },
          sheep: { min: 2, max: 8 },
          cow: { min: 2, max: 8 },
          pig: { min: 2, max: 6 }
        },
        enclosureStatus: inferEnclosureStatus(nearbyEntities, nearbyBlocks),
        outputs: {
          chicken: ["eggs", "meat"],
          sheep: ["wool", "meat"],
          cow: ["milk", "leather", "meat"],
          pig: ["meat"]
        },
        welfareFlags: inferLivestockFlags(nearbyEntities, nearbyBlocks)
      },
      combat_state: {
        hostilesNearby: nearbyEntities.filter((entity) => entity.type === "hostile").length,
        strongestThreat: nearbyEntities.find((entity) => entity.type === "hostile")?.name,
        armorScore: armorScore(bot),
        weaponTier: inferWeaponTier(bot.heldItem?.name ?? bestWeapon(bot)?.name),
        shelterDistance: nearestShelter ? distanceBetween(bot.entity.position, nearestShelter) : undefined,
        escapeRouteKnown: Boolean(nearestShelter)
      },
      safe_route_state: {
        homeRouteKnown: Boolean(homeAnchor),
        nearestShelter: nearestShelter ?? undefined,
        nightSafeRadius: 24
      },
      workstation_state: {
        craftingTableNearby: Boolean(bot.findBlock({ matching: byBlockName(bot, "crafting_table"), maxDistance: 8 })),
        furnaceNearby: Boolean(bot.findBlock({ matching: byBlockName(bot, "furnace"), maxDistance: 8 })),
        smokerNearby: Boolean(bot.findBlock({ matching: byBlockName(bot, "smoker"), maxDistance: 8 })),
        blastFurnaceNearby: Boolean(bot.findBlock({ matching: byBlockName(bot, "blast_furnace"), maxDistance: 8 })),
        chestNearby: storageSites.length > 0
      },
      storage_sites: storageSites,
      crop_sites: cropSites,
      terrain_affordances: terrainAffordances,
      protected_areas: [],
      settlement_zones: []
    };
  }

  async executeIntent(intent: AgentIntent, context?: IntentExecutionContext): Promise<ActionReport> {
    const bot = this.requireBot();

    try {
      if (intent.intent_type === "move" || intent.intent_type === "retreat") {
        const target = this.resolveTarget(bot, intent.target);
        if (!target) {
          return report(intent.intent_type, "blocked", ["No reachable movement target was available."], true);
        }
        await this.moveTo(bot, target);
        return report(intent.intent_type, "completed", ["Moved to target location."], false);
      }

      switch (intent.intent_type) {
        case "sleep":
          return this.sleepOrMove(bot, intent);
        case "eat":
          return this.consumeFood(bot);
        case "craft":
          return context?.craftGoal ? this.executeCraftGoal(bot, context.craftGoal) : report("craft", "blocked", ["No craft goal provided."], true);
        case "smelt":
          return this.smeltUsefulItem(bot, typeof intent.target === "string" ? intent.target : undefined);
        case "gather":
        case "mine":
          return this.executeGatherOrMine(bot, typeof intent.target === "string" ? intent.target : undefined, intent.intent_type);
        case "store":
          return this.storeItems(bot);
        case "farm":
          return this.farmNearby(bot);
        case "tend_livestock":
          return this.tendLivestock(bot);
        case "build":
        case "rebuild":
        case "repair":
          return context?.buildPlan
            ? this.executeBuildPlan(bot, context.buildPlan, intent.intent_type)
            : report(intent.intent_type, "blocked", ["No build plan was provided."], true);
        case "fight":
          return this.fightNearestHostile(bot);
        case "recover":
          return this.recover(bot);
        case "socialize": {
          const nearbyPlayer = Object.values(bot.entities).find(
            (entity) => entity.id !== bot.entity.id && inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "player"
          );
          if (nearbyPlayer?.position) {
            await bot.lookAt(nearbyPlayer.position);
          }
          if (intent.dialogue) {
            bot.chat(intent.dialogue);
          }
          return report("socialize", "completed", [intent.dialogue ?? "Shared a quiet moment."], false);
        }
        case "observe":
          return report("observe", "completed", [describeNearby(bot)], false);
        default:
          return report(intent.intent_type, "blocked", ["Intent executor not implemented yet."], true);
      }
    } catch (error) {
      return report(intent.intent_type, "failed", [error instanceof Error ? error.message : String(error)], true);
    }
  }

  private resolveTarget(bot: Bot, target: AgentIntent["target"]): Vec3 | undefined {
    if (isVec3Target(target)) {
      return target;
    }
    if (!target) {
      return resolveHomeAnchor(bot) ?? nearestNamedBlock(bot, ["crafting_table", "chest", "door"]) ?? undefined;
    }
    return resolveNamedTarget(bot, target);
  }

  private async moveTo(bot: Bot, target: Vec3): Promise<void> {
    if (this.GoalNear && (bot as any).pathfinder) {
      await (bot as any).pathfinder.goto(new this.GoalNear(target.x, target.y, target.z, 1));
      return;
    }

    await bot.lookAt(toVec3(target));
  }

  private async moveNear(bot: Bot, target: Vec3, range = 1): Promise<void> {
    if (this.GoalNear && (bot as any).pathfinder) {
      await (bot as any).pathfinder.goto(new this.GoalNear(target.x, target.y, target.z, range));
      return;
    }
    await this.moveTo(bot, target);
  }

  private async sleepOrMove(bot: Bot, intent: AgentIntent): Promise<ActionReport> {
    const target = this.resolveTarget(bot, intent.target);
    if (target) {
      await this.moveTo(bot, target);
    }
    const bed = bot.findBlock({ matching: (block: { name: string }) => block.name.includes("bed"), maxDistance: 4 });
    if (bed && typeof (bot as any).sleep === "function") {
      await (bot as any).sleep(bed);
      return report("sleep", "completed", ["Slept in bed."], false);
    }
    return report("sleep", "partial", ["Moved toward rest, but no usable bed was available."], true);
  }

  private async consumeFood(bot: Bot): Promise<ActionReport> {
    const food = bot.inventory.items()
      .filter((item) => isKnownFood(item.name))
      .sort((a, b) => foodPriority(b.name) - foodPriority(a.name))[0];
    if (!food) {
      return report("eat", "blocked", ["No known food is available in inventory."], true);
    }
    if (bot.food >= 20) {
      return report("eat", "partial", ["Already full enough; saving food for later."], false);
    }

    await bot.equip(food, "hand");
    await bot.consume();
    return report("eat", "completed", [`Ate ${food.name}.`], false, { [food.name]: -1 });
  }

  private async executeCraftGoal(bot: Bot, goal: CraftGoal): Promise<ActionReport> {
    const notes: string[] = [];

    for (const step of goal.recipe_path) {
      if (step.station === "furnace" || step.station === "smoker" || step.station === "blast_furnace") {
        const smeltReport = await this.smeltUsefulItem(bot, step.item, step.station);
        notes.push(...smeltReport.notes);
        if (smeltReport.status === "blocked" || smeltReport.status === "failed") {
          return smeltReport;
        }
        continue;
      }

      const item = bot.registry.itemsByName[step.item];
      if (!item) {
        continue;
      }

      const stationBlock = step.station === "crafting_table" ? await this.ensureStation(bot, "crafting_table") : null;
      if (step.station === "crafting_table" && !stationBlock) {
        return report("craft", "blocked", ["A crafting table is required but could not be found or placed."], true);
      }

      const recipes = bot.recipesFor(item.id, null, step.count, stationBlock ?? null);
      const recipe = recipes[0];
      if (!recipe) {
        return report("craft", "blocked", [`Missing recipe or station for ${step.item}.`], true);
      }

      await bot.craft(recipe, step.count, stationBlock ?? undefined);
      notes.push(`Made ${step.item}.`);
    }

    return report("craft", "completed", [`Crafted ${goal.target_item}.`, ...notes], false);
  }

  private async ensureStation(bot: Bot, station: "crafting_table" | "furnace" | "smoker" | "blast_furnace"): Promise<BotBlock | null> {
    const nearby = bot.findBlock({ matching: byBlockName(bot, station), maxDistance: 8 });
    if (nearby) {
      return nearby;
    }

    const inventoryItem = bot.inventory.items().find((item) => item.name === station);
    if (!inventoryItem) {
      return null;
    }

    const placed = await this.placeBlockAt(bot, floorVec(bot.entity.position), station, true);
    if (placed !== "placed") {
      return null;
    }
    await delay(150);
    return bot.findBlock({ matching: byBlockName(bot, station), maxDistance: 4 }) ?? null;
  }

  private async smeltUsefulItem(
    bot: Bot,
    preferredOutput?: string,
    preferredStation?: "furnace" | "smoker" | "blast_furnace"
  ): Promise<ActionReport> {
    const station = preferredStation ?? "furnace";
    const furnaceBlock = await this.ensureStation(bot, station);
    if (!furnaceBlock) {
      return report("smelt", "blocked", [`No ${station.replace(/_/g, " ")} is nearby or placeable.`], true);
    }

    const smeltable = findSmeltableInput(bot.inventory.items(), preferredOutput);
    const fuel = bot.inventory.items().find((item) => knownFuels.includes(item.name));
    if (!smeltable || !fuel) {
      return report("smelt", "blocked", ["Need both a smeltable item and fuel."], true);
    }

    const furnace: any = await bot.openFurnace(furnaceBlock);
    try {
      await furnace.putInput(smeltable.type, null, 1);
      await furnace.putFuel(fuel.type, null, 1);
      await delay(1250);
      const outputItem = typeof furnace.outputItem === "function" ? furnace.outputItem() : undefined;
      if (outputItem && typeof furnace.takeOutput === "function") {
        await furnace.takeOutput();
        return report(
          "smelt",
          "completed",
          [`Smelted ${smeltable.name} into ${outputItem.name}.`],
          false,
          { [smeltable.name]: -1, [fuel.name]: -1, [outputItem.name]: outputItem.count ?? 1 }
        );
      }
      return report("smelt", "partial", [`Started smelting ${smeltable.name} using ${fuel.name}.`], true, {
        [smeltable.name]: -1,
        [fuel.name]: -1
      });
    } finally {
      furnace.close();
    }
  }

  private async executeGatherOrMine(bot: Bot, targetName: string | undefined, intentType: "gather" | "mine"): Promise<ActionReport> {
    const block = findTargetBlock(bot, targetName);
    if (!block) {
      return report(
        intentType,
        "blocked",
        [targetName ? `Could not find ${targetName} nearby.` : "Could not find a nearby target block."],
        true
      );
    }

    const tool = bestToolForBlock(bot, block.name);
    if (tool) {
      await bot.equip(tool, "hand");
    }

    const collector = (bot as any).collectBlock;
    if (collector?.collect) {
      await collector.collect(block);
      return report(intentType, "completed", [`Collected ${block.name}.`], false);
    }

    await this.moveNear(bot, toSharedVec(block.position), 2);
    await bot.dig(block);
    return report(intentType, "completed", [`Dug ${block.name}.`], false);
  }

  private async storeItems(bot: Bot): Promise<ActionReport> {
    let chestBlock = bot.findBlock({
      matching: (block: { name: string }) => block.name.includes("chest") || block.name.includes("barrel"),
      maxDistance: 8
    });
    if (!chestBlock) {
      const chestItem = bot.inventory.items().find((item) => item.name === "chest");
      if (chestItem) {
        const placed = await this.placeBlockAt(bot, floorVec(bot.entity.position), "chest", true);
        if (placed === "placed") {
          chestBlock = bot.findBlock({
            matching: (block: { name: string }) => block.name.includes("chest") || block.name.includes("barrel"),
            maxDistance: 4
          });
        }
      }
    }
    if (!chestBlock) {
      return report("store", "blocked", ["Need a nearby chest or barrel first."], true);
    }

    const itemsToStore = bot.inventory.items()
      .map((entry) => ({ ...entry, overflow: storableOverflow(entry.name, entry.count) }))
      .filter((entry) => entry.overflow > 0);
    if (itemsToStore.length === 0) {
      return report("store", "partial", ["There is nothing obvious to store right now."], false);
    }

    const chest: any = await bot.openChest(chestBlock);
    const inventoryDelta: Record<string, number> = {};
    const notes: string[] = [];
    try {
      for (const item of itemsToStore.slice(0, 10)) {
        try {
          await chest.deposit(item.type, null, item.overflow);
          inventoryDelta[item.name] = -item.overflow;
          notes.push(`Stored ${item.overflow} ${item.name}.`);
        } catch (error) {
          notes.push(`Could not store ${item.name}: ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
    } finally {
      chest.close();
    }

    const storedAny = Object.keys(inventoryDelta).length > 0;
    return report(
      "store",
      storedAny ? "completed" : "blocked",
      storedAny ? notes : ["Storage was nearby, but nothing could be deposited."],
      !storedAny,
      inventoryDelta
    );
  }

  private async farmNearby(bot: Bot): Promise<ActionReport> {
    const notes: string[] = [];
    const inventoryDelta: Record<string, number> = {};

    for (const matureCrop of findMatureCrops(bot).slice(0, 4)) {
      const seedItemName = seedForCrop(matureCrop.name);
      await this.moveNear(bot, toSharedVec(matureCrop.position), 2);
      await bot.dig(matureCrop);
      notes.push(`Harvested ${matureCrop.name}.`);
      if (seedItemName) {
        const farmland = bot.blockAt(matureCrop.position.offset(0, -1, 0));
        const seeds = bot.inventory.items().find((item) => item.name === seedItemName);
        if (farmland && seeds && farmland.name === "farmland") {
          await bot.equip(seeds, "hand");
          await bot.placeBlock(farmland, faceUpVector() as any);
          inventoryDelta[seedItemName] = (inventoryDelta[seedItemName] ?? 0) - 1;
          notes.push(`Replanted ${seedItemName}.`);
        }
      }
    }

    if (notes.length > 0) {
      return report("farm", "completed", notes, false, inventoryDelta);
    }

    const openFarmland = findOpenFarmland(bot).slice(0, 4);
    const plantable = bot.inventory.items().find((item) => plantableSeeds.includes(item.name));
    if (openFarmland.length > 0 && plantable) {
      await bot.equip(plantable, "hand");
      for (const farmland of openFarmland) {
        await this.moveNear(bot, toSharedVec(farmland.position), 2);
        await bot.placeBlock(farmland, faceUpVector() as any);
        inventoryDelta[plantable.name] = (inventoryDelta[plantable.name] ?? 0) - 1;
        notes.push(`Planted ${plantable.name}.`);
      }
      return report("farm", "completed", notes, false, inventoryDelta);
    }

    const tilled = await this.prepareFarmland(bot);
    if (tilled) {
      return report("farm", "partial", ["Prepared new farmland for future planting."], true);
    }

    return report("farm", "blocked", ["No ripe crops, open farmland, or tillable ground were available."], true);
  }

  private async prepareFarmland(bot: Bot): Promise<boolean> {
    const hoe = bot.inventory.items().find((item) => item.name.includes("_hoe"));
    if (!hoe) {
      return false;
    }
    const dirt = bot.findBlock({
      matching: (block: { name: string; position: { offset: (x: number, y: number, z: number) => unknown } }) =>
        ["dirt", "grass_block"].includes(block.name),
      maxDistance: 10
    });
    if (!dirt || !hasAdjacentWater(bot, dirt.position, 4)) {
      return false;
    }
    const above = bot.blockAt(dirt.position.offset(0, 1, 0));
    if (!above || above.name !== "air") {
      return false;
    }

    await this.moveNear(bot, toSharedVec(dirt.position), 2);
    await bot.equip(hoe, "hand");
    await bot.activateBlock(dirt);
    return true;
  }

  private async tendLivestock(bot: Bot): Promise<ActionReport> {
    const animals = Object.values(bot.entities)
      .filter((entity): entity is BotEntity => inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "passive" && bot.entity.position.distanceTo(entity.position) <= 18)
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
    if (animals.length === 0) {
      return report("tend_livestock", "blocked", ["No nearby livestock to tend."], true);
    }

    const grouped = new Map<string, BotEntity[]>();
    for (const animal of animals) {
      const species = classifyLivestockSpecies(animal.username ?? animal.name ?? "animal");
      grouped.set(species, [...(grouped.get(species) ?? []), animal]);
    }

    for (const [species, matches] of grouped.entries()) {
      const adults = matches.filter((animal) => !Boolean((animal.metadata ?? []).some((entry: unknown) => entry === true)));
      const feedName = feedForSpecies(species);
      const feed = feedName ? bot.inventory.items().find((item) => item.name === feedName && item.count >= 2) : undefined;
      if (feed && adults.length >= 2) {
        await bot.equip(feed, "hand");
        for (const animal of adults.slice(0, 2)) {
          await this.moveNear(bot, toSharedVec(animal.position), 2);
          if ((bot as any).activateEntity) {
            await (bot as any).activateEntity(animal);
            await delay(180);
          }
        }
        return report("tend_livestock", "completed", [`Fed ${species} for breeding.`], false, { [feed.name]: -2 });
      }

      if (species === "sheep") {
        const shears = bot.inventory.items().find((item) => item.name === "shears");
        if (shears && adults.length > 0 && (bot as any).activateEntity) {
          await bot.equip(shears, "hand");
          await this.moveNear(bot, toSharedVec(adults[0].position), 2);
          await (bot as any).activateEntity(adults[0]);
          return report("tend_livestock", "completed", ["Sheared a nearby sheep."], false);
        }
      }

      if (species === "cow") {
        const bucket = bot.inventory.items().find((item) => item.name === "bucket");
        if (bucket && adults.length > 0 && (bot as any).activateEntity) {
          await bot.equip(bucket, "hand");
          await this.moveNear(bot, toSharedVec(adults[0].position), 2);
          await (bot as any).activateEntity(adults[0]);
          return report("tend_livestock", "completed", ["Milked a nearby cow."], false, { bucket: -1, milk_bucket: 1 });
        }
      }
    }

    const first = animals[0];
    await this.moveNear(bot, toSharedVec(first.position), 2);
    return report("tend_livestock", "partial", [`Checked on nearby ${classifyLivestockSpecies(first.username ?? first.name ?? "animals")}.`], true);
  }

  private async executeBuildPlan(bot: Bot, buildPlan: BuildPlan, intentType: "build" | "rebuild" | "repair"): Promise<ActionReport> {
    const center = buildCenter(bot, buildPlan.intent.site);
    const radius = buildRadius(buildPlan.intent.site);
    const notes: string[] = [];
    const inventoryDelta: Record<string, number> = {};
    const worldDelta: string[] = [];

    if (intentType === "rebuild" || intentType === "repair") {
      const cleared = await this.clearFootprint(bot, center, radius);
      if (cleared > 0) {
        notes.push(`Cleared ${cleared} obstructions before rebuilding.`);
        worldDelta.push(`cleared ${cleared} obstructions`);
      }
    }

    const placements = capPlacementsToInventory(bot, this.planPlacements(bot, buildPlan));
    if (placements.length === 0) {
      return report(intentType, "blocked", ["The current build plan did not produce placeable steps."], true);
    }

    let placed = 0;
    for (const placement of placements) {
      const result = await this.placeBlockAt(bot, placement.position, placement.item);
      if (result === "placed") {
        notes.push(`Placed ${placement.item}.`);
        worldDelta.push(`placed ${placement.item} at ${placement.position.x},${placement.position.y},${placement.position.z}`);
        inventoryDelta[placement.item] = (inventoryDelta[placement.item] ?? 0) - 1;
        placed += 1;
      }
    }

    if (placed === 0) {
      return report(intentType, "blocked", ["Could not place any planned blocks from the current build step."], true);
    }

    return report(
      intentType,
      placed < placements.length ? "partial" : "completed",
      notes,
      placed < placements.length,
      inventoryDelta,
      worldDelta
    );
  }

  private planPlacements(bot: Bot, buildPlan: BuildPlan): Array<{ position: Vec3; item: string }> {
    const center = buildCenter(bot, buildPlan.intent.site);
    const y = Math.floor(center.y);
    const radius = buildRadius(buildPlan.intent.site);

    if (isLivestockPlan(buildPlan)) {
      const fence = pickInventoryMaterial(bot, ["oak_fence", "spruce_fence", "birch_fence", "jungle_fence", "acacia_fence", "fence"]);
      if (!fence) {
        return [];
      }
      const gate = pickInventoryMaterial(bot, ["oak_fence_gate", "spruce_fence_gate", "birch_fence_gate", "jungle_fence_gate", "fence_gate"]);
      const torch = pickInventoryMaterial(bot, ["torch", "lantern"]);
      return [
        ...perimeterPlacements(center.x, y, center.z, Math.max(3, radius), fence, gate),
        ...cornerLights(center.x, y + 1, center.z, Math.max(3, radius), torch)
      ];
    }

    const mainBlock = pickInventoryMaterial(
      bot,
      Object.keys(buildPlan.material_budget).filter((name) => !utilityBlocks.includes(name) && !name.includes("fence_gate"))
    );
    const floorBlock = mainBlock ?? pickInventoryMaterial(bot, ["oak_planks", "spruce_planks", "cobblestone", "dirt"]);
    if (!floorBlock) {
      return [];
    }

    const placements: Array<{ position: Vec3; item: string }> = [];
    const doorwayZ = Math.floor(center.z + radius);
    const doorwayX = Math.floor(center.x);

    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const x = Math.floor(center.x + dx);
        const z = Math.floor(center.z + dz);
        placements.push({ position: { x, y, z }, item: floorBlock });

        const edge = Math.abs(dx) === radius || Math.abs(dz) === radius;
        const doorway = x === doorwayX && z === doorwayZ;
        if (edge && !doorway) {
          placements.push({ position: { x, y: y + 1, z }, item: mainBlock ?? floorBlock });
          placements.push({ position: { x, y: y + 2, z }, item: mainBlock ?? floorBlock });
        }
      }
    }

    const roofBlock = pickInventoryMaterial(bot, [mainBlock ?? floorBlock, "oak_slab", "spruce_slab"]);
    if (roofBlock) {
      for (let dx = -(radius - 1); dx <= radius - 1; dx += 1) {
        for (let dz = -(radius - 1); dz <= radius - 1; dz += 1) {
          placements.push({
            position: { x: Math.floor(center.x + dx), y: y + 3, z: Math.floor(center.z + dz) },
            item: roofBlock
          });
        }
      }
    }

    const bed = pickInventoryMaterial(bot, ["white_bed", "red_bed", "blue_bed", "bed"]);
    if (bed) {
      placements.push({ position: { x: Math.floor(center.x), y: y + 1, z: Math.floor(center.z) }, item: bed });
    }
    const chest = pickInventoryMaterial(bot, ["chest", "barrel"]);
    if (chest) {
      placements.push({ position: { x: Math.floor(center.x - 1), y: y + 1, z: Math.floor(center.z) }, item: chest });
    }
    const craftingTable = pickInventoryMaterial(bot, ["crafting_table"]);
    if (craftingTable) {
      placements.push({ position: { x: Math.floor(center.x + 1), y: y + 1, z: Math.floor(center.z) }, item: craftingTable });
    }
    const furnace = pickInventoryMaterial(bot, ["furnace", "smoker", "blast_furnace"]);
    if (furnace) {
      placements.push({ position: { x: Math.floor(center.x + 1), y: y + 1, z: Math.floor(center.z - 1) }, item: furnace });
    }
    const lights = pickInventoryMaterial(bot, ["torch", "lantern"]);
    placements.push(...cornerLights(center.x, y + 1, center.z, radius, lights));

    return placements.slice(0, 72);
  }

  private async clearFootprint(bot: Bot, center: Vec3, radius: number): Promise<number> {
    const clearable = bot.findBlocks({
      matching: (block: { name: string }) => clearableBlockNames.some((name) => block.name.includes(name)),
      maxDistance: Math.max(8, radius + 3),
      count: 18
    })
      .map((position) => bot.blockAt(position))
      .filter((block): block is BotBlock => Boolean(block))
      .filter((block) => Math.abs(block.position.x - center.x) <= radius && Math.abs(block.position.z - center.z) <= radius);

    let cleared = 0;
    for (const block of clearable.slice(0, 12)) {
      await this.moveNear(bot, toSharedVec(block.position), 2);
      await bot.dig(block);
      cleared += 1;
    }
    return cleared;
  }

  private async placeBlockAt(bot: Bot, target: Vec3, itemName: string, allowAnchorFallback = false): Promise<"placed" | "skipped"> {
    const targetVec = toVec3(target);
    const current = bot.blockAt(targetVec);
    if (current && !isReplaceable(current.name)) {
      return current.name === itemName ? "skipped" : "skipped";
    }
    const inventoryItem = bot.inventory.items().find((item) => item.name === itemName);
    if (!inventoryItem) {
      return "skipped";
    }

    const supportOptions = [
      { block: bot.blockAt(targetVec.offset(0, -1, 0)), face: faceUpVector() },
      { block: bot.blockAt(targetVec.offset(1, 0, 0)), face: { x: -1, y: 0, z: 0 } },
      { block: bot.blockAt(targetVec.offset(-1, 0, 0)), face: { x: 1, y: 0, z: 0 } },
      { block: bot.blockAt(targetVec.offset(0, 0, 1)), face: { x: 0, y: 0, z: -1 } },
      { block: bot.blockAt(targetVec.offset(0, 0, -1)), face: { x: 0, y: 0, z: 1 } }
    ];
    let support = supportOptions.find((entry) => entry.block && !isReplaceable(entry.block.name));

    if (!support?.block && allowAnchorFallback) {
      const feetBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (feetBlock && !isReplaceable(feetBlock.name)) {
        support = { block: feetBlock, face: faceUpVector() };
      }
    }
    if (!support?.block) {
      return "skipped";
    }

    await this.moveNear(bot, target, 2);
    await bot.equip(inventoryItem, "hand");
    await bot.placeBlock(support.block, support.face as any);
    return "placed";
  }

  private async fightNearestHostile(bot: Bot): Promise<ActionReport> {
    const hostile = Object.values(bot.entities)
      .filter((entity): entity is BotEntity => inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "hostile")
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
    if (!hostile) {
      return report("fight", "blocked", ["No hostile target is close enough to engage."], true);
    }
    const distance = bot.entity.position.distanceTo(hostile.position);
    if (distance > COMBAT_ENGAGE_DISTANCE) {
      return report(
        "fight",
        "blocked",
        [`Detected ${hostile.name ?? "a hostile"}, but it is still outside melee range.`],
        true
      );
    }
    if (bot.health <= 8) {
      return report("fight", "partial", ["Too hurt to commit fully; retreat would be wiser."], true);
    }

    const weapon = bestWeapon(bot);
    if (weapon) {
      await bot.equip(weapon, "hand");
    }

    const startingHealth = bot.health;
    let swings = 0;
    while (
      hostile.isValid !== false &&
      swings < 8 &&
      bot.health > 6 &&
      bot.entity.position.distanceTo(hostile.position) <= COMBAT_ENGAGE_DISTANCE
    ) {
      await this.moveNear(bot, toSharedVec(hostile.position), 2);
      await bot.attack(hostile);
      swings += 1;
      await delay(325);
    }

    if (swings === 0) {
      return report(
        "fight",
        "blocked",
        [`Could not reach ${hostile.name ?? "the hostile"} to engage safely.`],
        true,
        {},
        [],
        Math.max(0, startingHealth - bot.health)
      );
    }

    return report(
      "fight",
      hostile.isValid === false ? "completed" : "partial",
      [
        hostile.isValid === false
          ? `Fought ${hostile.name ?? "hostile"} cautiously and ended the immediate threat.`
          : `Fought ${hostile.name ?? "hostile"} cautiously, but the threat remains.`
      ],
      hostile.isValid !== false,
      {},
      [],
      Math.max(0, startingHealth - bot.health)
    );
  }

  private async recover(bot: Bot): Promise<ActionReport> {
    const eaten = await this.consumeFood(bot);
    if (eaten.status === "completed") {
      return report("recover", "completed", ["Recovered by eating and regrouping."], false, eaten.inventory_delta);
    }

    const bed = resolveHomeAnchor(bot);
    if (bed) {
      await this.moveTo(bot, bed);
      return report("recover", "partial", ["Moved closer to shelter to recover."], true);
    }

    return report("recover", "partial", ["Recovery focused on staying put and avoiding more damage."], true);
  }

  private requireBot(): Bot {
    if (!this.bot) {
      throw new Error("Mineflayer bot has not been connected yet.");
    }
    return this.bot;
  }
}

const cropNames = ["wheat", "carrots", "potatoes", "beetroots"];
const cookedFoods = ["bread", "baked_potato", "cooked_beef", "cooked_mutton", "cooked_porkchop", "cooked_chicken"];
const plantableSeeds = ["wheat_seeds", "beetroot_seeds", "carrot", "potato"];
const knownFuels = ["coal", "charcoal", "oak_log", "spruce_log", "birch_log", "oak_planks", "spruce_planks", "birch_planks"];
const utilityBlocks = ["bed", "white_bed", "red_bed", "blue_bed", "chest", "barrel", "crafting_table", "furnace", "smoker", "blast_furnace", "torch", "lantern"];
const clearableBlockNames = ["grass", "flower", "fern", "snow", "vine", "leaves", "bush"];

function report(
  intentType: ActionReport["intent_type"],
  status: ActionReport["status"],
  notes: string[],
  needsReplan: boolean,
  inventoryDelta: Record<string, number> = {},
  worldDelta: string[] = [],
  damageTaken = 0
): ActionReport {
  return {
    intent_type: intentType,
    status,
    notes,
    damage_taken: damageTaken,
    inventory_delta: inventoryDelta,
    world_delta: worldDelta,
    needs_replan: needsReplan
  };
}

function toSharedVec(position: { x: number; y: number; z: number }): Vec3 {
  return { x: position.x, y: position.y, z: position.z };
}

function toVec3(position: Vec3): any {
  const Vec3Ctor = require("vec3").Vec3;
  return new Vec3Ctor(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
}

function floorVec(position: { x: number; y: number; z: number }): Vec3 {
  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
}

function faceUpVector(): any {
  return { x: 0, y: 1, z: 0 };
}

function byBlockName(bot: Bot, name: string): number {
  const block = bot.registry.blocksByName[name];
  return block ? block.id : -1;
}

function nearestNamedBlock(bot: Bot, names: string[]): Vec3 | null {
  const block = bot.findBlock({
    matching: (candidate: { name: string }) => names.some((name) => candidate.name.includes(name)),
    maxDistance: 16
  });
  return block ? toSharedVec(block.position) : null;
}

function resolveHomeAnchor(bot: Bot): Vec3 | null {
  return nearestNamedBlock(bot, ["bed", "_bed"]) ?? nearestNamedBlock(bot, ["crafting_table", "chest", "door"]);
}

function resolveNamedTarget(bot: Bot, target: string): Vec3 | undefined {
  const lower = target.toLowerCase();
  if (["home", "bed", "rest", "sleep"].includes(lower)) {
    return resolveHomeAnchor(bot) ?? undefined;
  }
  if (["chest", "storage", "barrel"].includes(lower)) {
    return nearestNamedBlock(bot, ["chest", "barrel"]) ?? undefined;
  }
  if (["crafting", "crafting_table", "workshop"].includes(lower)) {
    return nearestNamedBlock(bot, ["crafting_table"]) ?? undefined;
  }
  if (["furnace", "smelter", "smoker", "blast_furnace"].includes(lower)) {
    return nearestNamedBlock(bot, ["furnace", "smoker", "blast_furnace"]) ?? undefined;
  }
  if (["farm", "field", "crops"].includes(lower)) {
    return nearestNamedBlock(bot, cropNames) ?? undefined;
  }
  if (["water", "river"].includes(lower)) {
    return nearestNamedBlock(bot, ["water"]) ?? undefined;
  }
  if (["tree", "wood"].includes(lower)) {
    return nearestNamedBlock(bot, ["log", "leaves"]) ?? undefined;
  }
  if (["animals", "livestock", "pen"].includes(lower)) {
    const animal = Object.values(bot.entities).find((entity) => inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "passive");
    return animal?.position ? toSharedVec(animal.position) : undefined;
  }
  const block = findTargetBlock(bot, target);
  return block ? toSharedVec(block.position) : undefined;
}

function inferWeather(bot: Bot): WeatherState {
  const thunderState = Number((bot as any).thunderState ?? 0);
  const rainState = Number((bot as any).rainState ?? ((bot as any).isRaining ? 1 : 0));
  if (thunderState > 0) {
    return "thunder";
  }
  if (rainState > 0) {
    return "rain";
  }
  return "clear";
}

function inferLightLevel(block: BotBlockMaybe): number {
  if (!block) {
    return 15;
  }
  const level = Number((block as any).light ?? (block as any).skyLight ?? 15);
  return Number.isFinite(level) ? level : 15;
}

function distanceBetween(position: { x: number; y: number; z: number }, target: Vec3): number {
  return Math.sqrt((position.x - target.x) ** 2 + (position.y - target.y) ** 2 + (position.z - target.z) ** 2);
}

function inferTerrainAffordances(
  bot: Bot,
  nearbyBlocks: Array<{ name: string; position: Vec3 }>
): NonNullable<PerceptionFrame["terrain_affordances"]> {
  const affordances: NonNullable<PerceptionFrame["terrain_affordances"]> = [];
  const baseY = Math.floor(bot.entity.position.y);

  for (const block of nearbyBlocks) {
    if (block.name.includes("water")) {
      affordances.push({ type: "water", location: block.position, note: "Water nearby for farming or quiet reflection." });
      continue;
    }
    if (block.name.includes("log") || block.name.includes("leaves")) {
      affordances.push({ type: "tree", location: block.position, note: "Wood and shade are nearby." });
      continue;
    }
    if (block.name.includes("cave") || block.name.includes("deepslate")) {
      affordances.push({ type: "cave", location: block.position, note: "A darker opening suggests depth or danger." });
      continue;
    }
    if (block.name.includes("lava") || block.name.includes("fire")) {
      affordances.push({ type: "hazard", location: block.position, note: "A dangerous patch that deserves caution." });
      continue;
    }
    if (Math.abs(block.position.y - baseY) >= 3) {
      affordances.push({ type: "slope", location: block.position, note: "The land rises or falls sharply here." });
      continue;
    }
  }

  if (nearbyBlocks.filter((block) => Math.abs(block.position.y - baseY) <= 1).length >= 12) {
    affordances.push({
      type: "flat",
      location: floorVec(bot.entity.position),
      note: "This patch of land is gentle enough to build on."
    });
  }
  if (bot.entity.position.y >= 75) {
    affordances.push({
      type: "view",
      location: floorVec(bot.entity.position),
      note: "The higher ground opens into a wider view."
    });
  }

  return uniqueAffordances(affordances);
}

function uniqueAffordances(
  affordances: NonNullable<PerceptionFrame["terrain_affordances"]>
): NonNullable<PerceptionFrame["terrain_affordances"]> {
  const seen = new Set<string>();
  const next: NonNullable<PerceptionFrame["terrain_affordances"]> = [];
  for (const affordance of affordances) {
    const key = `${affordance.type}:${Math.round(affordance.location.x)}:${Math.round(affordance.location.z)}`;
    if (!seen.has(key)) {
      seen.add(key);
      next.push(affordance);
    }
  }
  return next.slice(0, 12);
}

function inferEntityType(name: string, entityType?: string): "hostile" | "passive" | "neutral" | "player" | "item" | "unknown" {
  const lower = `${entityType ?? ""} ${name}`.toLowerCase();
  if (entityType === "player" || lower.includes("player")) {
    return "player";
  }
  if (["zombie", "skeleton", "creeper", "spider", "witch", "slime", "enderman", "drowned", "phantom"].some((entry) => lower.includes(entry))) {
    return "hostile";
  }
  if (["cow", "sheep", "pig", "chicken", "horse"].some((entry) => lower.includes(entry))) {
    return "passive";
  }
  if (lower.includes("item")) {
    return "item";
  }
  return "unknown";
}

function classifyLivestockSpecies(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("cow")) {
    return "cow";
  }
  if (lower.includes("sheep")) {
    return "sheep";
  }
  if (lower.includes("pig")) {
    return "pig";
  }
  if (lower.includes("chicken")) {
    return "chicken";
  }
  return "animal";
}

function countLivestock(entities: Array<{ name: string; type: string }>): Record<string, number> {
  return entities.reduce<Record<string, number>>((acc, entity) => {
    if (entity.type !== "passive") {
      return acc;
    }
    const species = classifyLivestockSpecies(entity.name);
    acc[species] = (acc[species] ?? 0) + 1;
    return acc;
  }, {});
}

function inferEnclosureStatus(
  entities: Array<{ name: string; type: string }>,
  blocks: Array<{ name: string }>
): Record<string, "safe" | "open" | "crowded" | "unknown"> {
  const counts = countLivestock(entities);
  const hasFences = blocks.some((block) => block.name.includes("fence"));
  return Object.fromEntries(
    Object.entries(counts).map(([species, count]) => [
      species,
      !hasFences ? "open" : count >= 10 ? "crowded" : "safe"
    ])
  );
}

function inferLivestockFlags(
  entities: Array<{ name: string; type: string; isBaby?: boolean }>,
  blocks: Array<{ name: string }>
): string[] {
  const passive = entities.filter((entity) => entity.type === "passive");
  const flags: string[] = [];
  if (passive.length >= 4 && !blocks.some((block) => block.name.includes("fence"))) {
    flags.push("animals_unpenned");
  }
  if (passive.length >= 10) {
    flags.push("possible_overcrowding");
  }
  return flags;
}

function armorScore(bot: Bot): number {
  return bot.inventory.slots.slice(5, 9).filter(Boolean).length * 5;
}

function inferWeaponTier(name?: string): "none" | "wood" | "stone" | "iron" | "better" {
  if (!name) {
    return "none";
  }
  if (name.includes("netherite") || name.includes("diamond")) {
    return "better";
  }
  if (name.includes("iron")) {
    return "iron";
  }
  if (name.includes("stone")) {
    return "stone";
  }
  if (name.includes("wood")) {
    return "wood";
  }
  return "none";
}

function bestWeapon(bot: Bot): BotItem | undefined {
  const preference = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword", "iron_axe", "stone_axe", "wooden_axe"];
  return bot.inventory.items()
    .filter((item) => preference.includes(item.name))
    .sort((a, b) => preference.indexOf(a.name) - preference.indexOf(b.name))[0];
}

function bestToolForBlock(bot: Bot, blockName: string): BotItem | undefined {
  const preference = blockName.includes("log") || blockName.includes("wood")
    ? ["diamond_axe", "iron_axe", "stone_axe", "wooden_axe"]
    : blockName.includes("dirt") || blockName.includes("sand") || blockName.includes("gravel")
      ? ["diamond_shovel", "iron_shovel", "stone_shovel", "wooden_shovel"]
      : ["diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"];

  return bot.inventory.items()
    .filter((item) => preference.includes(item.name))
    .sort((a, b) => preference.indexOf(a.name) - preference.indexOf(b.name))[0];
}

function countFood(inventory: Record<string, number>, names: string[]): number {
  return names.reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
}

function estimateInventoryCalories(inventory: Record<string, number>): number {
  const weights: Record<string, number> = {
    bread: 250,
    baked_potato: 180,
    cooked_beef: 400,
    cooked_mutton: 300,
    cooked_porkchop: 340,
    cooked_chicken: 220,
    carrot: 60,
    apple: 90
  };
  return Object.entries(weights).reduce((sum, [item, calories]) => sum + (inventory[item] ?? 0) * calories, 0);
}

function estimateReserveDays(hunger: number, inventory: Record<string, number>): number {
  const cooked = countFood(inventory, cookedFoods);
  const roughMeals = cooked + Math.floor((inventory.carrot ?? 0) / 3) + Math.floor((inventory.apple ?? 0) / 2);
  if (hunger >= 18 && roughMeals >= 4) {
    return 2;
  }
  if (hunger >= 12 && roughMeals >= 2) {
    return 1;
  }
  return 0;
}

function inferNotablePlaces(
  blocks: Array<{ name: string }>,
  entities: Array<{ type: string; name: string }>,
  affordances: NonNullable<PerceptionFrame["terrain_affordances"]>
): string[] {
  const notes = new Set<string>();
  if (blocks.some((block) => block.name.includes("water"))) {
    notes.add("near water");
  }
  if (blocks.some((block) => block.name.includes("flower"))) {
    notes.add("flower patch");
  }
  if (entities.some((entity) => entity.type === "player")) {
    notes.add("company nearby");
  }
  for (const affordance of affordances) {
    if (affordance.type === "view") {
      notes.add("wide view");
    }
    if (affordance.type === "flat") {
      notes.add("good building ground");
    }
  }
  return [...notes].slice(0, 6);
}

function inferShelterScore(blocks: Array<{ name: string }>): number {
  let score = 0.35;
  if (blocks.some((block) => block.name.includes("bed"))) {
    score += 0.2;
  }
  if (blocks.some((block) => block.name.includes("door") || block.name.includes("trapdoor"))) {
    score += 0.15;
  }
  if (blocks.some((block) => block.name.includes("glass") || block.name.includes("planks") || block.name.includes("cobblestone") || block.name.includes("stone_bricks"))) {
    score += 0.1;
  }
  if (blocks.some((block) => block.name.includes("torch") || block.name.includes("lantern"))) {
    score += 0.1;
  }
  return Math.min(0.9, score);
}

function describeNearby(bot: Bot): string {
  const player = Object.values(bot.entities).find(
    (entity) => entity.id !== bot.entity.id && inferEntityType(entity.username ?? entity.name ?? "", entity.type) === "player"
  );
  const view = bot.findBlock({ matching: (block: { name: string }) => !block.name.includes("air"), maxDistance: 6 });
  if (player) {
    return `I notice ${player.username ?? player.name ?? "someone"} nearby.`;
  }
  if (view) {
    return `I pause to take in the ${view.name.replace(/_/g, " ")} nearby.`;
  }
  return "I pause and take in the quiet of the world around me.";
}

function cropStage(block: BotBlockMaybe): "seedling" | "growing" | "ripe" | "unknown" {
  if (!block) {
    return "unknown";
  }
  const props = (block as any).getProperties?.() ?? {};
  const age = Number(props.age ?? (block as any).metadata ?? 0);
  if (age >= 7) {
    return "ripe";
  }
  if (age > 0) {
    return "growing";
  }
  return "seedling";
}

function findMatureCrops(bot: Bot): BotBlock[] {
  return bot.findBlocks({
    matching: (block: { name: string }) => cropNames.includes(block.name),
    maxDistance: 12,
    count: 16
  })
    .map((position) => bot.blockAt(position))
    .filter((block): block is BotBlock => Boolean(block))
    .filter((block) => cropStage(block) === "ripe");
}

function findOpenFarmland(bot: Bot): BotBlock[] {
  return bot.findBlocks({
    matching: byBlockName(bot, "farmland"),
    maxDistance: 12,
    count: 12
  })
    .map((position) => bot.blockAt(position))
    .filter((block): block is BotBlock => Boolean(block))
    .filter((farmland) => bot.blockAt(farmland.position.offset(0, 1, 0))?.name === "air");
}

function seedForCrop(crop: string): string | undefined {
  switch (crop) {
    case "wheat":
      return "wheat_seeds";
    case "beetroots":
      return "beetroot_seeds";
    case "carrots":
      return "carrot";
    case "potatoes":
      return "potato";
    default:
      return undefined;
  }
}

function feedForSpecies(species: string): string | undefined {
  if (species === "cow" || species === "sheep") {
    return "wheat";
  }
  if (species === "pig") {
    return "carrot";
  }
  if (species === "chicken") {
    return "wheat_seeds";
  }
  return undefined;
}

function hasAdjacentWater(bot: Bot, position: { offset: (x: number, y: number, z: number) => any }, radius: number): boolean {
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const block = bot.blockAt(position.offset(dx, 0, dz));
      if (block?.name.includes("water")) {
        return true;
      }
    }
  }
  return false;
}

function isKnownFood(name: string): boolean {
  return [...cookedFoods, "carrot", "apple"].includes(name);
}

function foodPriority(name: string): number {
  if (cookedFoods.includes(name)) {
    return 5;
  }
  if (name === "bread") {
    return 4;
  }
  if (name === "carrot") {
    return 2;
  }
  if (name === "apple") {
    return 1;
  }
  return 0;
}

function storableOverflow(name: string, count: number): number {
  if (name.includes("pickaxe") || name.includes("axe") || name.includes("sword") || name.includes("shovel") || name.includes("hoe")) {
    return Math.max(0, count - 1);
  }
  if (name.includes("shield") || name.includes("shears") || name.includes("bucket")) {
    return Math.max(0, count - 1);
  }
  if (isKnownFood(name)) {
    return Math.max(0, count - 4);
  }
  if (plantableSeeds.includes(name)) {
    return Math.max(0, count - 16);
  }
  if (name === "torch" || name === "lantern") {
    return Math.max(0, count - 16);
  }
  if (name.includes("planks") || name.includes("log") || name.includes("cobblestone") || name.includes("dirt") || name.includes("fence")) {
    return Math.max(0, count - 32);
  }
  return Math.max(0, count - 8);
}

function findSmeltableInput(items: BotItem[], preferredOutput?: string): BotItem | undefined {
  const candidates = [
    { input: "raw_iron", output: "iron_ingot" },
    { input: "raw_copper", output: "copper_ingot" },
    { input: "raw_gold", output: "gold_ingot" },
    { input: "sand", output: "glass" },
    { input: "clay_ball", output: "brick" },
    { input: "raw_beef", output: "cooked_beef" },
    { input: "raw_porkchop", output: "cooked_porkchop" },
    { input: "raw_mutton", output: "cooked_mutton" },
    { input: "raw_chicken", output: "cooked_chicken" },
    { input: "potato", output: "baked_potato" }
  ];
  const preferred = preferredOutput ? candidates.find((entry) => entry.output === preferredOutput) : undefined;
  if (preferred) {
    return items.find((item) => item.name === preferred.input);
  }
  return items.find((item) => candidates.some((entry) => entry.input === item.name));
}

function pickInventoryMaterial(bot: Bot, preferredNames: string[]): string | undefined {
  for (const name of preferredNames) {
    if (bot.inventory.items().some((item) => item.name === name && item.count > 0)) {
      return name;
    }
  }
  return bot.inventory.items()
    .filter((item) => !isKnownFood(item.name))
    .sort((a, b) => b.count - a.count)[0]?.name;
}

function findTargetBlock(bot: Bot, targetName?: string): BotBlockMaybe {
  const normalized = targetName?.toLowerCase();
  return bot.findBlock({
    matching: (candidate: { name: string }) => matchesTargetName(candidate.name, normalized),
    maxDistance: 16
  });
}

function matchesTargetName(blockName: string, targetName?: string): boolean {
  if (!targetName) {
    return !blockName.includes("air");
  }
  if (blockName === targetName) {
    return true;
  }
  if ((targetName === "wood" || targetName === "tree") && (blockName.includes("log") || blockName.includes("wood"))) {
    return true;
  }
  if (targetName === "stone" && (blockName.includes("stone") || blockName.includes("cobblestone"))) {
    return true;
  }
  if (targetName === "food" && cropNames.includes(blockName)) {
    return true;
  }
  return blockName.includes(targetName);
}

function isLivestockPlan(buildPlan: BuildPlan): boolean {
  const text = [buildPlan.intent.purpose, ...buildPlan.intent.style_tags, ...buildPlan.intent.functional_requirements].join(" ").toLowerCase();
  return text.includes("livestock") || text.includes("pen") || text.includes("animal") || text.includes("barn") || text.includes("pasture");
}

function buildCenter(bot: Bot, site: SiteArea): Vec3 {
  return site.center ?? floorVec(bot.entity.position);
}

function buildRadius(site: SiteArea): number {
  if (site.radius && site.radius > 0) {
    return Math.max(2, Math.min(4, Math.floor(site.radius)));
  }
  if (site.footprint) {
    return Math.max(2, Math.min(4, Math.ceil(Math.max(site.footprint.width, site.footprint.depth) / 2)));
  }
  return 2;
}

function perimeterPlacements(centerX: number, y: number, centerZ: number, radius: number, fence: string, gate?: string) {
  const placements: Array<{ position: Vec3; item: string }> = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const isEdge = Math.abs(dx) === radius || Math.abs(dz) === radius;
      if (!isEdge) {
        continue;
      }
      const isGate = Boolean(gate) && dx === 0 && dz === radius;
      placements.push({
        position: { x: Math.floor(centerX + dx), y, z: Math.floor(centerZ + dz) },
        item: isGate ? gate! : fence
      });
    }
  }
  return placements;
}

function cornerLights(centerX: number, y: number, centerZ: number, radius: number, light?: string) {
  if (!light) {
    return [];
  }
  return [
    { position: { x: Math.floor(centerX - radius), y, z: Math.floor(centerZ - radius) }, item: light },
    { position: { x: Math.floor(centerX + radius), y, z: Math.floor(centerZ - radius) }, item: light },
    { position: { x: Math.floor(centerX - radius), y, z: Math.floor(centerZ + radius) }, item: light },
    { position: { x: Math.floor(centerX + radius), y, z: Math.floor(centerZ + radius) }, item: light }
  ];
}

function capPlacementsToInventory(bot: Bot, placements: Array<{ position: Vec3; item: string }>): Array<{ position: Vec3; item: string }> {
  const counts = bot.inventory.items().reduce<Record<string, number>>((acc, item) => {
    acc[item.name] = (acc[item.name] ?? 0) + item.count;
    return acc;
  }, {});
  const used = new Map<string, number>();
  const next: Array<{ position: Vec3; item: string }> = [];
  for (const placement of placements) {
    const current = used.get(placement.item) ?? 0;
    const available = counts[placement.item] ?? 0;
    if (current < available) {
      used.set(placement.item, current + 1);
      next.push(placement);
    }
  }
  return next;
}

function isReplaceable(name: string): boolean {
  return (
    name === "air" ||
    name === "cave_air" ||
    name === "void_air" ||
    name.includes("grass") ||
    name.includes("flower") ||
    name.includes("fern") ||
    name.includes("snow") ||
    name.includes("vine")
  );
}

function isVec3Target(target: AgentIntent["target"]): target is Vec3 {
  return Boolean(target && typeof target !== "string" && typeof target.x === "number");
}

async function onceSpawn(bot: Bot): Promise<void> {
  if ((bot as any).entity) {
    return;
  }
  await new Promise<void>((resolve) => bot.once("spawn", () => resolve()));
}
