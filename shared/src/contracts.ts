export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type WeatherState = "clear" | "rain" | "thunder" | "unknown";

export type BuildActionKind =
  | "survey"
  | "clear"
  | "salvage"
  | "gather"
  | "craft"
  | "smelt"
  | "place"
  | "remove"
  | "decorate"
  | "inspect";

export type IntentType =
  | "move"
  | "observe"
  | "eat"
  | "sleep"
  | "gather"
  | "mine"
  | "craft"
  | "smelt"
  | "build"
  | "rebuild"
  | "repair"
  | "store"
  | "farm"
  | "tend_livestock"
  | "socialize"
  | "retreat"
  | "fight"
  | "recover";

export type EpisodeEventType =
  | "discovery"
  | "food"
  | "crafting"
  | "building"
  | "rebuild"
  | "livestock"
  | "combat"
  | "social"
  | "beauty"
  | "sleep"
  | "danger"
  | "recovery";

export type ReplanTrigger =
  | "spawn"
  | "wake"
  | "dawn"
  | "dusk"
  | "damage"
  | "hunger_threshold"
  | "hostile_detection"
  | "inventory_change"
  | "task_completion"
  | "task_failure"
  | "player_interaction"
  | "protected_area_conflict"
  | "idle_check";

export type ReplanLevel = "hard" | "soft" | "micro";

export type ActionStatus = "completed" | "partial" | "blocked" | "failed" | "interrupted";

export interface NearbyEntity {
  id: string;
  name: string;
  type: "hostile" | "passive" | "neutral" | "player" | "item" | "unknown";
  distance: number;
  position?: Vec3;
  isBaby?: boolean;
  isAggressive?: boolean;
}

export interface NearbyBlock {
  name: string;
  position: Vec3;
  distance: number;
  harvestable?: boolean;
  safeToRemove?: boolean;
}

export interface HomeState {
  anchor?: Vec3;
  shelterScore: number;
  bedAvailable: boolean;
  workshopReady: boolean;
  guestCapacity: number;
  lastRenovatedDay?: number;
}

export interface PantryState {
  carriedCalories: number;
  pantryCalories: number;
  cookedMeals: number;
  cropReadiness: number;
  emergencyReserveDays: number;
}

export interface FarmState {
  farmlandReady: boolean;
  plantedCrops: string[];
  hydratedTiles: number;
  harvestableTiles: number;
  seedStock: Record<string, number>;
}

export interface LivestockState {
  counts: Record<string, number>;
  targetRanges: Record<string, { min: number; max: number }>;
  enclosureStatus: Record<string, "safe" | "open" | "crowded" | "unknown">;
  outputs: Record<string, string[]>;
  welfareFlags: string[];
}

export interface CombatState {
  hostilesNearby: number;
  strongestThreat?: string;
  armorScore: number;
  weaponTier: "none" | "wood" | "stone" | "iron" | "better";
  shelterDistance?: number;
  escapeRouteKnown: boolean;
}

export interface SafeRouteState {
  homeRouteKnown: boolean;
  nearestShelter?: Vec3;
  nightSafeRadius: number;
}

export interface AffectState {
  mood: number;
  stress: number;
  loneliness: number;
  wonder: number;
  security: number;
  belonging: number;
  satisfaction: number;
}

export interface WorkstationState {
  craftingTableNearby: boolean;
  furnaceNearby: boolean;
  smokerNearby: boolean;
  blastFurnaceNearby: boolean;
  chestNearby: boolean;
}

export interface StorageSite {
  label: string;
  location: Vec3;
  contents: Record<string, number>;
}

export interface CropSite {
  crop: string;
  location: Vec3;
  stage: "seedling" | "growing" | "ripe" | "unknown";
  irrigated: boolean;
}

export interface TerrainAffordance {
  type: "flat" | "slope" | "water" | "tree" | "cave" | "view" | "hazard";
  location: Vec3;
  note: string;
}

export interface ProtectedArea {
  id: string;
  label: string;
  center: Vec3;
  radius: number;
  owner?: string;
  world?: string;
}

export interface SettlementZone {
  id: string;
  label: string;
  center: Vec3;
  radius: number;
  purpose: string;
}

export interface PerceptionFrame {
  agent_id: string;
  tick_time: number;
  position: Vec3;
  biome?: string;
  weather: WeatherState;
  light_level: number;
  health: number;
  hunger: number;
  inventory: Record<string, number>;
  equipped_item?: string;
  nearby_entities: NearbyEntity[];
  nearby_blocks: NearbyBlock[];
  home_state: HomeState;
  active_project?: string;
  snapshot_refs: string[];
  notable_places: string[];
  pantry_state: PantryState;
  farm_state: FarmState;
  livestock_state: LivestockState;
  combat_state: CombatState;
  safe_route_state: SafeRouteState;
  workstation_state?: WorkstationState;
  storage_sites?: StorageSite[];
  crop_sites?: CropSite[];
  terrain_affordances?: TerrainAffordance[];
  protected_areas?: ProtectedArea[];
  settlement_zones?: SettlementZone[];
}

export interface CraftStep {
  item: string;
  count: number;
  station: "hand" | "crafting_table" | "furnace" | "smoker" | "blast_furnace";
  ingredients: Record<string, number>;
}

export interface CraftGoal {
  target_item: string;
  quantity: number;
  purpose: string;
  deadline?: string;
  required_stations: string[];
  required_tools: string[];
  recipe_path: CraftStep[];
  missing_inputs: Record<string, number>;
}

export interface SiteArea {
  center?: Vec3;
  radius?: number;
  footprint?: { width: number; depth: number; height?: number };
}

export interface BuildIntent {
  purpose: string;
  site: SiteArea;
  style_tags: string[];
  functional_requirements: string[];
  aesthetic_goals: string[];
  materials_preference: string[];
  expandable: boolean;
  rebuild_of?: string;
  remove_or_salvage_plan?: string;
}

export interface BuildAction {
  kind: BuildActionKind;
  description: string;
  block?: string;
  count?: number;
  site?: SiteArea;
  requiredItem?: string;
}

export interface BuildStage {
  id: string;
  title: string;
  purpose: string;
  actions: BuildAction[];
  completion_checks: string[];
}

export interface BuildPlan {
  intent: BuildIntent;
  site_constraints: string[];
  material_budget: Record<string, number>;
  dependency_order: string[];
  salvage_steps: string[];
  stages: BuildStage[];
  completion_checks: string[];
}

export interface AgentIntent {
  agent_id: string;
  intent_type: IntentType;
  target?: string | Vec3;
  reason: string;
  priority: number;
  cancel_conditions: string[];
  success_conditions: string[];
  dialogue?: string;
  trigger?: ReplanTrigger;
}

export interface SleepEpisode {
  agent_id: string;
  day_number: number;
  timestamp: string;
  location: Vec3;
  event_type: EpisodeEventType;
  summary: string;
  importance: number;
  tags: string[];
  participants: string[];
  needs: string[];
  outcome: string;
  food_delta: number;
  damage_taken: number;
  resource_delta: Record<string, number>;
  snapshot_refs: string[];
  affect: AffectState;
}

export interface CultureSignal {
  source_player: string;
  signal_type: "praise" | "critique" | "gift" | "invitation" | "thank_you";
  topic: string;
  valence: number;
  strength: number;
  notes?: string;
  timestamp: string;
}

export interface SafetyFloors {
  preserveRenewableFood: boolean;
  noGriefing: boolean;
  noStealing: boolean;
  sleepNightly: boolean;
}

export interface ValueProfile {
  survival: number;
  food_security: number;
  safety: number;
  curiosity: number;
  craftsmanship: number;
  beauty: number;
  comfort: number;
  sociability: number;
  hospitality: number;
  stewardship: number;
  competence: number;
  joy: number;
  safetyFloors: SafetyFloors;
  updatedAt: string;
}

export type RoutinePhase = "dawn" | "work" | "homeward" | "dusk" | "night";

export type ResidentChronotype = "early" | "steady" | "late";

export type ResidentMotif = "homesteader" | "wanderer" | "caretaker" | "tinkerer" | "sentinel" | "host";

export interface ResidentTraitProfile {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  threat_sensitivity: number;
}

export interface ResidentPersonalityProfile {
  seed: string;
  traits: ResidentTraitProfile;
  chronotype: ResidentChronotype;
  motifs: {
    primary: ResidentMotif;
    secondary?: ResidentMotif;
  };
  style_tags: string[];
  updated_at: string;
}

export interface ResidentNeedState {
  safety: number;
  rest: number;
  hunger: number;
  autonomy: number;
  competence: number;
  relatedness: number;
  beauty: number;
}

export interface ResidentMindState {
  valence: number;
  arousal: number;
  confidence: number;
  frustration: number;
  fatigueDebt: number;
  routinePhase: RoutinePhase;
}

export interface BootstrapProgress {
  woodSecured: boolean;
  toolsReady: boolean;
  shelterSecured: boolean;
  lightSecured: boolean;
  foodSecured: boolean;
  bedSecured: boolean;
}

export interface RecentActionSnapshot {
  timestamp: string;
  intent_type: IntentType;
  target_class: string;
  status: ActionStatus;
  position_delta: number;
  risk_context: "safe" | "exposed" | "threatened" | "sheltered";
}

export interface CombatPolicy {
  engage_threshold: number;
  retreat_threshold: number;
  night_travel_limit: number;
  protect_home_radius: number;
  preferred_weapon_mode: "melee" | "ranged" | "best_available";
  panic_recovery_steps: string[];
}

export interface MemoryObservation {
  timestamp: string;
  category: EpisodeEventType | "orientation" | "project" | "weather" | "hospitality";
  summary: string;
  tags: string[];
  importance: number;
  source: "perception" | "dialogue" | "action" | "recovery" | "reflection";
  location?: Vec3;
  related_project_id?: string;
  affect?: AffectState;
}

export interface ProjectState {
  id: string;
  title: string;
  kind: "build" | "rebuild" | "farm" | "livestock" | "explore" | "social" | "recovery" | "craft";
  status: "planned" | "active" | "blocked" | "paused" | "complete";
  summary: string;
  location?: Vec3;
  updated_at: string;
}

export interface WakeOrientation {
  day_number: number;
  created_at: string;
  immediate_needs: string[];
  risk_flags: string[];
  carry_over_commitments: string[];
  recalled_memories: string[];
  current_priorities: string[];
  narration?: string;
}

export interface MemoryState {
  current_day: number;
  personality_profile: ResidentPersonalityProfile;
  self_name?: string;
  self_name_chosen_at?: string;
  need_state: ResidentNeedState;
  mind_state: ResidentMindState;
  bootstrap_progress: BootstrapProgress;
  home_anchor?: Vec3;
  known_beds: Vec3[];
  workstation_state: WorkstationState;
  storage_sites: StorageSite[];
  pantry_notes: string[];
  crop_sites: CropSite[];
  safe_shelters: Vec3[];
  routes_home: Vec3[];
  protected_areas: ProtectedArea[];
  settlement_zones: SettlementZone[];
  active_build_zones: SettlementZone[];
  salvage_tasks: string[];
  combat_posture: string[];
  craft_backlog: CraftGoal[];
  build_backlog: BuildIntent[];
  active_projects: ProjectState[];
  current_goals: string[];
  recent_observations: MemoryObservation[];
  recent_interactions: string[];
  recent_dangers: string[];
  recent_action_snapshots: RecentActionSnapshot[];
  place_tags: string[];
  affect: AffectState;
  self_narrative: string[];
  carry_over_commitments: string[];
  last_wake_orientation?: WakeOrientation;
  last_updated_at: string;
}

export interface MemoryBundle {
  agent_id: string;
  day_number: number;
  created_at: string;
  summary: string;
  personality_profile: ResidentPersonalityProfile;
  self_name: string;
  need_state: ResidentNeedState;
  mind_state: ResidentMindState;
  bootstrap_progress: BootstrapProgress;
  observations: MemoryObservation[];
  active_projects: ProjectState[];
  carry_over_commitments: string[];
  recent_dangers: string[];
  recent_interactions: string[];
  recent_action_snapshots: RecentActionSnapshot[];
  place_tags: string[];
  final_affect: AffectState;
}

export interface RecallQuery {
  query: string;
  place?: string;
  entity?: string;
  project_id?: string;
  mood?: string;
  tags?: string[];
  limit?: number;
}

export interface RecallMatch {
  timestamp: string;
  summary: string;
  tags: string[];
  relevance: number;
}

export interface RecallResult {
  query: RecallQuery;
  matches: RecallMatch[];
}

export interface OvernightConsolidation {
  day_number: number;
  created_at: string;
  summary: string;
  personality_profile: ResidentPersonalityProfile;
  self_name: string;
  insights: string[];
  carry_over_commitments: string[];
  risk_themes: string[];
  place_memories: string[];
  project_memories: string[];
  value_shift_summary: string[];
  creative_motifs: string[];
}

export interface ActionReport {
  intent_type: IntentType;
  status: ActionStatus;
  notes: string[];
  damage_taken: number;
  inventory_delta: Record<string, number>;
  world_delta: string[];
  needs_replan: boolean;
}

export interface DailyOutcome {
  dayNumber: number;
  survived: boolean;
  sleptInBed: boolean;
  mealsConsumed: number;
  hungerEmergencies: number;
  damageTaken: number;
  combatsWon: number;
  retreatsUsed: number;
  hostedPlayers: number;
  explorationMoments: number;
  craftedItems: number;
  buildActions: number;
  livestockStable: boolean;
  joyMoments: number;
  recoveryMoments?: number;
  setbacksFaced?: number;
  meaningMoments?: number;
}

export interface ConsolidationRecord {
  dayNumber: number;
  createdAt: string;
  summary: string;
  insights: string[];
  linkedObservationTimestamps: string[];
  overnight: OvernightConsolidation;
}
