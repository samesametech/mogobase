import { ObjectId } from "mongodb"
import merge from "lodash.merge"

const processValue = (value: any) => {
  if (value && typeof value.getMonth === "function") {
    return new Date(value).valueOf()
  }

  return value
}

const processOrAndFilter = (filter: any) => {
  // Note:
  // input = { '$or': [ { email: 'chardy@gmail.com' }, { email: 'abc@gmail.com' } ]}
  // output = { '$or': [ { email: { '$regex': '.*$chardy@gmail.com.*'} }, { email: { '$regex': '.*$abc@gmail.com.*'} } ]}

  let filters = [] as any[]
  for (let key in filter) {
    let obj = filter[key]

    Object.keys(obj).forEach((item) => {
      const k = item

      if (key && k) {
        filters.push(processFilter({ [k]: obj[k] }))
      }
    })
  }

  return filters
}

const processKey = (key: string, opts: any) => {
  if (key === "_id") {
    return key
  }

  const { allowSnakeCase } = opts || {}

  if (!allowSnakeCase) {
    return key.replace(/_/g, ".")
  }

  return key
}

const processFilter = (filter: any, opts?: any) => {
  let filters = {}
  let newFilters = {}

  for (let key in filter) {
    if (filter[key] === "") {
      // Do nothing
    } else if (key == "OR" || key == "or") {
      // query = filter: { OR: [{email: "chardy@gmail.com"}, {email: "abc@gmail.com"}] }
      // output = { "$or":[{"email":{"$regex":".*chardy@gmail.com.*"}},{"email":{"$regex":".*abc@gmail.com.*"}}] }
      filters = { $or: processOrAndFilter(filter[key]) }
    } else if (key == "AND" || key == "and") {
      // query = filter: { AND: [{email: "chardy@gmail.com"}, {email: "abc@gmail.com"}] }
      // output = { "$and":[{"email":{"$regex":".*chardy@gmail.com.*"}},{"email":{"$regex":".*abc@gmail.com.*"}}] }
      filters = { $and: processOrAndFilter(filter[key]) }
    } else if (key.indexOf("_id") > 0 && key.includes("Id")) {
      // query = filter: { userId_id: "5f8d..." } → output = { userId: ObjectId(...) }
      // When coerceObjectId === false (e.g., RxDB), keep the value as string.
      const value = opts?.coerceObjectId === false ? filter[key] : new ObjectId(filter[key])
      filters = { [key.replace("_id", "")]: value }
    } else if (key.includes("_eq")) {
      // equal ==
      // query = filter: { amount_eq: 20}
      // output = { amount: { $eq: 20 }}
      filters = {
        [processKey(key.replace("_eq", ""), opts)]: {
          $eq: processValue(filter[key]),
        },
      }
    } else if (key.includes("_ne")) {
      // not equal !=
      // query = filter: { amount_ne: 20}
      // output = { amount: { $ne: 20 }}
      filters = {
        [processKey(key.replace("_ne", ""), opts)]: {
          $ne: processValue(filter[key]),
        },
      }
    } else if (key.includes("_lte")) {
      // less than equal <=
      // query = filter: { amount_lte: 20}
      // output = { amount: { $lte: 20 }}
      filters = {
        [processKey(key.replace("_lte", ""), opts)]: {
          $lte: processValue(filter[key]),
        },
      }
    } else if (key.includes("_gte")) {
      // greater than equal >=
      // query = filter: { amount_gte: 20}
      // output = { amount: { $gte: 20 }}
      filters = {
        [processKey(key.replace("_gte", ""), opts)]: {
          $gte: processValue(filter[key]),
        },
      }
    } else if (key.includes("_lt")) {
      // less than <
      // query = filter: { amount_lt: 20}
      // output = { amount: { $lt: 20 }}
      filters = {
        [processKey(key.replace("_lt", ""), opts)]: {
          $lt: processValue(filter[key]),
        },
      }
    } else if (key.includes("_gt")) {
      // greater than >
      // query = filter: { amount_gt: 20}
      // output = { amount: { $gt: 20 }}
      filters = {
        [processKey(key.replace("_gt", ""), opts)]: {
          $gt: processValue(filter[key]),
        },
      }
    } else if (key.includes("_between")) {
      // query = filter: { amount_between: [20, 30]}
      // output = { amount: { $gte: 20, $lte: 30 }}
      filters = {
        [processKey(key.replace("_between", ""), opts)]: {
          $gte: processValue(filter[key][0]),
          $lte: processValue(filter[key][1]),
        },
      }
    } else if (key.includes("_in")) {
      // same like IN sql
      // query = filter: { email_in: ["chardy@gmail.com", "abc@gmail.com"]}
      // output = { email: { $in: ["chardy@gmail.com", "abc@gmail.com"] }}
      filters = {
        [processKey(key.replace("_in", ""), opts)]: {
          $in: processValue(filter[key]),
        },
      }
    } else if (key.includes("_all")) {
      // same like ALL sql
      // query = filter: { email_all: ["chardy@gmail.com", "abc@gmail.com"]}
      // output = { email: { $all: ["chardy@gmail.com", "abc@gmail.com"] }}
      filters = {
        [processKey(key.replace("_all", ""), opts)]: { $all: filter[key] },
      }
    } else if (key.includes("_nin")) {
      // not in
      // query = filter: { email_nin: ["chardy@gmail.com", "abc@gmail.com"]}
      // output = { email: { $nin: ["chardy@gmail.com", "abc@gmail.com"] }}
      filters = {
        [processKey(key.replace("_nin", ""), opts)]: {
          $nin: processValue(filter[key]),
        },
      }
    } else if (key.includes("_contains")) {
      // same like LIKE in SQL
      // query = filter: { email_contains: "chardy@gmail.com" }
      // output = { email: { "$regex":".*char.*" }}
      filters = {
        [processKey(key.replace("_contains", ""), opts)]: {
          $regex: `.*${filter[key]}.*`,
        },
      }
    } else if (key.includes("_regex")) {
      // use REGEX to search
      // query = filter: { email_regex: "^abc.*" }
      // output = { email: { "$regex":"^abc.*" }}
      filters = {
        [processKey(key.replace("_regex", ""), opts)]: {
          $regex: `${filter[key]}`,
          $options: "i",
        },
      }
    } else {
      // no regex search
      // query = filter: {email:"chardy@gmail.com"}
      // output = { "email":"chardy@gmail.com" }
      filters = { [processKey(key, opts)]: processValue(filter[key]) }
    }

    newFilters = merge(newFilters, filters)
  }

  return newFilters
}

export default (filter: any, opts?: any): any => {
  const newFilters = processFilter(filter, opts)
  return { ...newFilters, deletedAt: null }
}
