import { BuildIntent, BuildPlan, BuildStage, PerceptionFrame } from "@resident/shared";

function inferSpaces(intent: BuildIntent): string[] {
  const joined = [
    intent.purpose,
    ...intent.functional_requirements,
    ...intent.aesthetic_goals,
    ...intent.style_tags
  ]
    .join(" ")
    .toLowerCase();

  const spaces = new Set<string>();
  if (joined.includes("home") || joined.includes("cozy") || joined.includes("shelter")) {
    spaces.add("shelter");
    spaces.add("quiet corner");
  }
  if (joined.includes("guest") || joined.includes("host")) {
    spaces.add("guest area");
    spaces.add("commons");
  }
  if (joined.includes("barn") || joined.includes("livestock") || joined.includes("pen")) {
    spaces.add("pen");
    spaces.add("field edge");
  }
  if (joined.includes("garden") || joined.includes("farm")) {
    spaces.add("path");
    spaces.add("field edge");
  }
  if (joined.includes("lookout") || joined.includes("view")) {
    spaces.add("lookout");
  }
  if (joined.includes("work") || joined.includes("craft") || joined.includes("smelt")) {
    spaces.add("workshop");
    spaces.add("pantry");
  }

  if (spaces.size === 0) {
    spaces.add("shelter");
    spaces.add("commons");
  }

  return [...spaces];
}

function baseMaterials(intent: BuildIntent, perception: PerceptionFrame): Record<string, number> {
  const materials = new Map<string, number>();
  const preferred = intent.materials_preference.length > 0 ? intent.materials_preference : ["oak_planks", "cobblestone", "torch"];
  for (const material of preferred) {
    materials.set(material, (materials.get(material) ?? 0) + 24);
  }

  if (perception.home_state.guestCapacity > 0) {
    materials.set("bed", Math.max(materials.get("bed") ?? 0, perception.home_state.guestCapacity + 1));
  } else {
    materials.set("bed", Math.max(materials.get("bed") ?? 0, 1));
  }

  if (intent.functional_requirements.some((entry) => entry.toLowerCase().includes("storage"))) {
    materials.set("chest", 2);
  }

  return Object.fromEntries(materials.entries());
}

function stage(id: string, title: string, purpose: string, actions: BuildStage["actions"], checks: string[]): BuildStage {
  return {
    id,
    title,
    purpose,
    actions,
    completion_checks: checks
  };
}

export class SemanticBuildPlanner {
  plan(intent: BuildIntent, perception: PerceptionFrame): BuildPlan {
    const spaces = inferSpaces(intent);
    const siteConstraints = [
      "Prefer dry, lit, pathable terrain near home unless purpose implies remote siting.",
      "Leave enough clearance for expansion and routefinding.",
      "Keep doors, gates, and paths wide enough for repeated use.",
      "Avoid tearing down productive food systems unless an explicit salvage plan exists."
    ];

    const salvageSteps = intent.rebuild_of
      ? [
          `Inspect ${intent.rebuild_of} for reusable materials and sentimental elements.`,
          "Remove unsafe or ugly sections first.",
          "Preserve useful workstations, beds, and storage access during remodeling."
        ]
      : intent.remove_or_salvage_plan
        ? [intent.remove_or_salvage_plan]
        : [];

    const stages = [
      stage(
        "survey",
        "Read The Site",
        "Understand what the place wants to become before placing blocks.",
        [
          { kind: "survey", description: "Walk the footprint and note light, slope, hazards, and sightlines.", site: intent.site },
          { kind: "inspect", description: `Identify purpose spaces: ${spaces.join(", ")}.` }
        ],
        ["Site is traversable, memorable, and suitable for the intended mood."]
      ),
      stage(
        "salvage",
        "Salvage And Clear",
        "Keep what still has life; remove what blocks the new plan.",
        [
          { kind: "salvage", description: "Recover reusable blocks, doors, fences, lighting, and storage." },
          { kind: "clear", description: "Clear vegetation or blocks that block the new circulation pattern." }
        ],
        ["Build zone is safe, open, and stocked with salvaged materials."]
      ),
      stage(
        "frame",
        "Lay Out Form",
        "Define the shelter, pens, paths, and social edges with a flexible frame.",
        [
          { kind: "place", description: `Mark core zones for ${spaces.join(", ")}.` },
          { kind: "place", description: "Place structural supports, fences, or retaining edges where needed." }
        ],
        ["Every required space has a clear boundary and path connection."]
      ),
      stage(
        "utility",
        "Make It Livable",
        "Add the pieces that turn structure into life.",
        [
          { kind: "craft", description: "Craft missing workstations, doors, gates, chests, or beds as needed." },
          { kind: "place", description: "Install lighting, beds, storage, workstations, feeding access, and route markers." }
        ],
        ["Food, sleep, storage, and movement all work without friction."]
      ),
      stage(
        "beauty",
        "Refine Feeling",
        "Adjust until the place feels worth returning to.",
        [
          { kind: "decorate", description: "Tune wall rhythm, windows, path edges, planter zones, and lookouts." },
          { kind: "inspect", description: "Walk the finished space and note ugly or awkward sections for future revision." }
        ],
        ["The resident wants to use the space again and can explain why it feels right."]
      )
    ];

    return {
      intent,
      site_constraints: siteConstraints,
      material_budget: baseMaterials(intent, perception),
      dependency_order: stages.map((entry) => entry.id),
      salvage_steps: salvageSteps,
      stages,
      completion_checks: [
        "Purpose spaces are functional.",
        "The resident can navigate the structure at night safely.",
        "The build can be expanded or revised later without total teardown."
      ]
    };
  }
}
