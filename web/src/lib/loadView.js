// Fetch + cache a pre-computed view JSON (Layer 2). The frontend never
// touches the Parquet lake -- these small files are its entire data source.
const cache = new Map()

const BASE = `${import.meta.env.BASE_URL}views`

export async function loadView(name) {
  if (cache.has(name)) return cache.get(name)
  const promise = fetch(`${BASE}/${name}.json`).then((r) => {
    if (!r.ok) throw new Error(`view ${name}: HTTP ${r.status}`)
    return r.json()
  })
  cache.set(name, promise)
  try {
    return await promise
  } catch (e) {
    cache.delete(name)
    throw e
  }
}

export const loadMeta = () => loadView('meta')
export const loadSetDetail = (groupId) => loadView(`set_detail/${groupId}`)
