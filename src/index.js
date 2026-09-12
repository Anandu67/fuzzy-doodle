import mineflayer from 'mineflayer'
import 'dotenv/config'
import { pathfinder, Movements, goals } from 'mineflayer-pathfinder'
import fs from 'node:fs'
import path from 'node:path'
import { Vec3 } from 'vec3'

const {
  GoalNear,
  GoalBlock
} = goals

// ============================================================
// CONFIG
// ============================================================

const HOST = process.env.MC_HOST
const PORT = Number(process.env.MC_PORT || 25565)
const USERNAME = process.env.MC_USERNAME || 'SurvivalHelper'
const AUTH = process.env.MC_AUTH || 'offline'

const RADIUS_CHUNKS = Number(process.env.HOME_RADIUS_CHUNKS || 16)
const RADIUS_BLOCKS = RADIUS_CHUNKS * 16

const MEMORY_DIR = path.resolve('data')
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json')

if (!HOST || HOST === 'PUT_SERVER_IP_HERE') {
  console.log('Set MC_HOST in your .env file before starting the bot.')
  process.exit(0)
}

// ============================================================
// MEMORY
// ============================================================

fs.mkdirSync(MEMORY_DIR, { recursive: true })

const defaultMemory = {
  home: null,
  bed: null,
  farm: null,
  water: null,
  treeFarm: null,
  death: null,

  knownTrees: [],
  knownWater: [],
  safePlaces: [],
  dangerousPlaces: [],

  statistics: {
    seedsCollected: 0,
    cropsHarvested: 0,
    treesHarvested: 0,
    saplingsCollected: 0,
    tasksCompleted: 0,
    tasksFailed: 0
  },

  learning: {
    successes: {},
    failures: {},
    routes: {}
  }
}

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(
        MEMORY_FILE,
        JSON.stringify(defaultMemory, null, 2)
      )
      return structuredClone(defaultMemory)
    }

    return {
      ...structuredClone(defaultMemory),
      ...JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
    }
  } catch (error) {
    console.log('Could not load memory:', error.message)
    return structuredClone(defaultMemory)
  }
}

let memory = loadMemory()

function saveMemory() {
  try {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify(memory, null, 2)
    )
  } catch (error) {
    console.log('Could not save memory:', error.message)
  }
}

// ============================================================
// BOT
// ============================================================

let bot = null
let thinking = false
let reconnectTimer = null

function createBot() {
  console.log(`Connecting to ${HOST}:${PORT}...`)

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: AUTH,
    version: false
  })

  bot.loadPlugin(pathfinder)

  bot.once('spawn', async () => {
    console.log('Bot spawned.')

    const movements = new Movements(bot)

    // The bot should walk naturally.
    movements.allowSprinting = false
    movements.allowParkour = false
    movements.allow1by1towers = false

    bot.pathfinder.setMovements(movements)

    initialiseHome()

    console.log(`Movement boundary: ${RADIUS_BLOCKS} blocks`)
    console.log('Survival brain started.')

    await sleep(2000)

    brainLoop()
  })

  bot.on('death', () => {
    console.log('Bot died.')

    if (bot.entity) {
      memory.death = {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
        time: Date.now()
      }

      saveMemory()
    }
  })

  bot.on('error', error => {
    console.log('Bot error:', error.message)
  })

  bot.on('kicked', reason => {
    console.log('Bot kicked:', reason)
  })

  bot.on('end', () => {
    console.log('Bot disconnected.')

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }

    reconnectTimer = setTimeout(() => {
      console.log('Trying to reconnect...')
      createBot()
    }, 10000)
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return

    console.log(`[CHAT] ${username}: ${message}`)

    if (message === '!status') {
      bot.chat('I am alive and working.')
    }

    if (message === '!where') {
      if (bot.entity) {
        const p = bot.entity.position
        bot.chat(
          `Position: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
        )
      }
    }
  })
}

// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function distance(a, b) {
  return Math.sqrt(
    ((a.x || 0) - (b.x || 0)) ** 2 +
    ((a.y || 0) - (b.y || 0)) ** 2 +
    ((a.z || 0) - (b.z || 0)) ** 2
  )
}

function positionObject(pos) {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z)
  }
}

// ============================================================
// HOME / BOUNDARY
// ============================================================

function initialiseHome() {
  if (!memory.home && bot.entity) {
    memory.home = positionObject(bot.entity.position)
    saveMemory()

    console.log(
      `Home set at ${memory.home.x}, ${memory.home.y}, ${memory.home.z}`
    )
  }
}

function getBoundaryCenter() {
  // Bed becomes the preferred center once remembered.
  if (memory.bed) return memory.bed
  return memory.home
}

function insideBoundary(position) {
  const center = getBoundaryCenter()

  if (!center) return true

  return (
    Math.abs(position.x - center.x) <= RADIUS_BLOCKS &&
    Math.abs(position.z - center.z) <= RADIUS_BLOCKS
  )
}

function checkBoundary() {
  if (!bot?.entity) return true

  if (!insideBoundary(bot.entity.position)) {
    console.log('Outside allowed area. Returning toward home.')

    const center = getBoundaryCenter()

    if (center) {
      bot.pathfinder.setGoal(
        new GoalNear(
          center.x,
          center.y,
          center.z,
          4
        )
      )
    }

    return false
  }

  return true
}

// ============================================================
// PATHFINDING
// ============================================================

async function walkTo(position, range = 2) {
  if (!bot?.entity) return false

  if (!insideBoundary(position)) {
    console.log('Target is outside the allowed area.')
    return false
  }

  try {
    await bot.pathfinder.goto(
      new GoalNear(
        position.x,
        position.y,
        position.z,
        range
      )
    )

    return true
  } catch (error) {
    console.log('Pathfinding failed:', error.message)

    rememberFailure('pathfinding')

    return false
  }
}

// ============================================================
// BLOCK SEARCH
// ============================================================

function findNearestBlock(names, maxDistance = 32) {
  if (!bot?.entity) return null

  const nameSet = new Set(
    Array.isArray(names) ? names : [names]
  )

  const positions = bot.findBlocks({
    matching: block => nameSet.has(block.name),
    maxDistance,
    count: 30
  })

  if (!positions.length) return null

  positions.sort(
    (a, b) =>
      bot.entity.position.distanceTo(a) -
      bot.entity.position.distanceTo(b)
  )

  return positions[0]
}

// ============================================================
// INVENTORY
// ============================================================

function itemCount(names) {
  if (!bot) return 0

  const nameSet = new Set(
    Array.isArray(names) ? names : [names]
  )

  return bot.inventory.items()
    .filter(item => nameSet.has(item.name))
    .reduce((total, item) => total + item.count, 0)
}

function hasItem(names) {
  return itemCount(names) > 0
}

async function equipItem(names) {
  const nameSet = new Set(
    Array.isArray(names) ? names : [names]
  )

  const item = bot.inventory.items()
    .find(item => nameSet.has(item.name))

  if (!item) return false

  try {
    await bot.equip(item, 'hand')
    return true
  } catch {
    return false
  }
}

// ============================================================
// SEEDS
// ============================================================

async function gatherSeeds() {
  if (!bot?.entity) return false

  if (hasItem(['wheat_seeds'])) {
    return true
  }

  console.log('Looking for grass to collect seeds.')

  const grass = findNearestBlock(
    ['grass', 'short_grass'],
    32
  )

  if (!grass) {
    console.log('No nearby grass found.')
    return false
  }

  if (!insideBoundary(grass)) {
    return false
  }

  const reached = await walkTo(grass, 2)

  if (!reached) return false

  try {
    await bot.dig(bot.blockAt(grass))

    await sleep(500)

    collectNearbyDrops()

    memory.statistics.seedsCollected++
    rememberSuccess('gatherSeeds')

    saveMemory()

    return hasItem(['wheat_seeds'])
  } catch (error) {
    console.log('Seed gathering failed:', error.message)

    rememberFailure('gatherSeeds')

    return false
  }
}

// ============================================================
// WATER
// ============================================================

async function findWater() {
  const remembered = memory.water

  if (remembered && insideBoundary(remembered)) {
    return remembered
  }

  const water = findNearestBlock(
    ['water'],
    64
  )

  if (!water) return null

  memory.water = positionObject(water)
  saveMemory()

  return memory.water
}

// ============================================================
// FARM
// ============================================================

async function createFarm() {
  if (!bot?.entity) return false

  if (memory.farm) {
    return true
  }

  const water = await findWater()

  if (!water) {
    console.log('No water found for farm.')
    return false
  }

  console.log('Found water. Looking for farmland area.')

  const candidates = []

  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      if (x === 0 && z === 0) continue

      const pos = new Vec3(
        water.x + x,
        water.y,
        water.z + z
      )

      const block = bot.blockAt(pos)

      if (!block) continue

      if (
        block.name === 'dirt' ||
        block.name === 'grass_block'
      ) {
        candidates.push(pos)
      }
    }
  }

  if (!candidates.length) {
    console.log('No suitable farm blocks nearby.')
    return false
  }

  memory.farm = positionObject(candidates[0])
  saveMemory()

  console.log(
    `Farm location remembered at ${memory.farm.x}, ${memory.farm.y}, ${memory.farm.z}`
  )

  return true
}

// ============================================================
// HOE FARM BLOCKS
// ============================================================

async function tillNearbyBlocks() {
  if (!memory.farm) return false

  const equipped = await equipItem([
    'wooden_hoe',
    'stone_hoe',
    'iron_hoe',
    'diamond_hoe',
    'netherite_hoe'
  ])

  if (!equipped) {
    return false
  }

  const center = new Vec3(
    memory.farm.x,
    memory.farm.y,
    memory.farm.z
  )

  const blocks = []

  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      const block = bot.blockAt(
        center.offset(x, 0, z)
      )

      if (
        block &&
        (block.name === 'dirt' ||
         block.name === 'grass_block')
      ) {
        blocks.push(block)
      }
    }
  }

  for (const block of blocks) {
    if (!insideBoundary(block.position)) continue

    const reached = await walkTo(block.position, 3)

    if (!reached) continue

    try {
      await bot.activateBlock(block)
      await sleep(250)
    } catch {
      // Continue with the next block.
    }
  }

  return true
}

// ============================================================
// PLANT CROPS
// ============================================================

async function plantSeeds() {
  if (!hasItem(['wheat_seeds'])) {
    return false
  }

  await equipItem(['wheat_seeds'])

  const center = memory.farm
    ? new Vec3(
        memory.farm.x,
        memory.farm.y,
        memory.farm.z
      )
    : bot.entity.position

  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) {
      const block = bot.blockAt(
        center.offset(x, 0, z)
      )

      if (!block) continue

      if (block.name !== 'farmland') continue

      const above = bot.blockAt(
        block.position.offset(0, 1, 0)
      )

      if (!above || above.name !== 'air') continue

      if (!insideBoundary(block.position)) continue

      try {
        await walkTo(block.position, 3)
        await bot.activateBlock(block)
        await sleep(150)
      } catch {
        // Continue.
      }
    }
  }

  return true
}

// ============================================================
// HARVEST WHEAT
// ============================================================

async function harvestCrops() {
  const crop = findNearestBlock(
    ['wheat'],
    32
  )

  if (!crop) return false

  if (!insideBoundary(crop)) return false

  const block = bot.blockAt(crop)

  if (!block) return false

  // Wheat age 7 is fully grown.
  if (
    typeof block.metadata === 'number' &&
    block.metadata < 7
  ) {
    return false
  }

  const reached = await walkTo(crop, 2)

  if (!reached) return false

  try {
    await bot.dig(block)

    await sleep(500)

    collectNearbyDrops()

    memory.statistics.cropsHarvested++

    rememberSuccess('harvestCrop')

    saveMemory()

    // Immediately try to replant.
    await plantSeeds()

    return true
  } catch (error) {
    console.log('Crop harvesting failed:', error.message)
    rememberFailure('harvestCrop')
    return false
  }
}

// ============================================================
// TREES
// ============================================================

const LOGS = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log'
]

const SAPLINGS = [
  'oak_sapling',
  'birch_sapling',
  'spruce_sapling',
  'jungle_sapling',
  'acacia_sapling',
  'dark_oak_sapling',
  'mangrove_propagule',
  'cherry_sapling'
]

const LEAVES = [
  'oak_leaves',
  'birch_leaves',
  'spruce_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'mangrove_leaves',
  'cherry_leaves'
]

async function harvestTree() {
  const log = findNearestBlock(LOGS, 32)

  if (!log) return false

  if (!insideBoundary(log)) return false

  console.log('Tree found.')

  const reached = await walkTo(log, 3)

  if (!reached) return false

  let harvested = 0

  // Break nearby logs one at a time.
  for (let i = 0; i < 20; i++) {
    const nextLog = findNearestBlock(LOGS, 5)

    if (!nextLog) break

    if (!insideBoundary(nextLog)) break

    const block = bot.blockAt(nextLog)

    if (!block) break

    try {
      await bot.dig(block)

      harvested++

      await sleep(250)

      collectNearbyDrops()
    } catch {
      break
    }
  }

  if (harvested > 0) {
    memory.statistics.treesHarvested += harvested
    rememberSuccess('harvestTree')
    saveMemory()

    await collectNearbyDrops()
    await replantTrees()

    return true
  }

  rememberFailure('harvestTree')
  return false
}

// ============================================================
// TREE REPLANTING
// ============================================================

async function replantTrees() {
  const sapling = bot.inventory.items()
    .find(item => SAPLINGS.includes(item.name))

  if (!sapling) {
    console.log('No saplings available.')
    return false
  }

  await bot.equip(sapling, 'hand')

  const base = memory.treeFarm
    ? new Vec3(
        memory.treeFarm.x,
        memory.treeFarm.y,
        memory.treeFarm.z
      )
    : bot.entity.position.floored()

  if (!memory.treeFarm) {
    memory.treeFarm = positionObject(base)
    saveMemory()
  }

  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      const ground = bot.blockAt(
        base.offset(x, 0, z)
      )

      const air = bot.blockAt(
        base.offset(x, 1, z)
      )

      if (!ground || !air) continue

      const validGround = [
        'dirt',
        'grass_block',
        'podzol',
        'coarse_dirt',
        'moss_block'
      ].includes(ground.name)

      if (!validGround) continue
      if (air.name !== 'air') continue

      const pos = ground.position

      if (!insideBoundary(pos)) continue

      try {
        await walkTo(pos, 3)
        await bot.activateBlock(ground)
        await sleep(300)

        collectNearbyDrops()

        if (!hasItem(SAPLINGS)) {
          break
        }

        const nextSapling = bot.inventory.items()
          .find(item => SAPLINGS.includes(item.name))

        if (nextSapling) {
          await bot.equip(nextSapling, 'hand')
        }
      } catch {
        // Try another location.
      }
    }
  }

  return true
}

// ============================================================
// DROPS
// ============================================================

function collectNearbyDrops() {
  if (!bot) return

  const entities = Object.values(bot.entities)

  for (const entity of entities) {
    if (entity.name !== 'item') continue

    if (
      distance(
        entity.position,
        bot.entity.position
      ) > 8
    ) {
      continue
    }

    // Path toward nearby dropped items.
    walkTo(entity.position, 1.5)
      .catch(() => {})
  }
}

// ============================================================
// FOOD
// ============================================================

const FOOD = [
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'baked_potato',
  'apple',
  'carrot',
  'potato'
]

async function eatIfHungry() {
  if (!bot?.food) return

  if (bot.food > 10) return

  const food = bot.inventory.items()
    .find(item => FOOD.includes(item.name))

  if (!food) {
    console.log('Hungry, but no food available.')
    return
  }

  try {
    await bot.equip(food, 'hand')
    await bot.consume()

    console.log(`Ate ${food.name}.`)
  } catch (error) {
    console.log('Could not eat:', error.message)
  }
}

// ============================================================
// WOOD / BASIC TOOLS
// ============================================================

async function craftBasicTools() {
  const logs = itemCount(LOGS)

  if (logs < 2) {
    return false
  }

  // Convert logs into planks.
  const logItem = bot.inventory.items()
    .find(item => LOGS.includes(item.name))

  if (!logItem) return false

  try {
    const plankName =
      logItem.name.replace('_log', '_planks')

    const recipes = bot.recipesFor(
      bot.registry.itemsByName[plankName]?.id,
      null,
      1,
      null
    )

    if (recipes.length) {
      await bot.craft(recipes[0], 4)
    }
  } catch {
    // Crafting can fail if a version-specific recipe differs.
  }

  return true
}

// ============================================================
// SIMPLE LEARNING
// ============================================================

function rememberSuccess(task) {
  memory.learning.successes[task] =
    (memory.learning.successes[task] || 0) + 1

  memory.statistics.tasksCompleted++

  saveMemory()
}

function rememberFailure(task) {
  memory.learning.failures[task] =
    (memory.learning.failures[task] || 0) + 1

  memory.statistics.tasksFailed++

  saveMemory()
}

// ============================================================
// BRAIN
// ============================================================

async function brainStep() {
  if (!bot?.entity) return

  if (!checkBoundary()) {
    return
  }

  // Highest priority: hunger.
  await eatIfHungry()

  // Harvest a fully grown crop immediately.
  if (await harvestCrops()) {
    return
  }

  // Make sure a farm location exists.
  if (!memory.farm) {
    if (await createFarm()) {
      await tillNearbyBlocks()
    }
  }

  // Get seeds.
  if (!hasItem(['wheat_seeds'])) {
    if (await gatherSeeds()) {
      return
    }
  }

  // Till farmland.
  if (memory.farm) {
    await tillNearbyBlocks()
  }

  // Plant available seeds.
  if (hasItem(['wheat_seeds'])) {
    await plantSeeds()
  }

  // Maintain tree farm.
  if (
    itemCount(SAPLINGS) === 0 ||
    itemCount(LOGS) < 8
  ) {
    await harvestTree()
    return
  }

  // Collect nearby drops.
  collectNearbyDrops()

  // Small natural pause instead of constant movement.
  await sleep(
    1200 + Math.floor(Math.random() * 1800)
  )
}

async function brainLoop() {
  if (!bot) return

  if (thinking) return

  thinking = true

  try {
    await brainStep()
  } catch (error) {
    console.log('Brain error:', error.message)
  } finally {
    thinking = false
  }

  if (bot?.entity) {
    setTimeout(brainLoop, 1000)
  }
}

// ============================================================
// START
// ============================================================

createBot()
