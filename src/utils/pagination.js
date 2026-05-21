const paginate = async (model, query = {}, options = {}) => {
  const page = Math.max(1, parseInt(options.page) || 1);
  const limit = Math.min(100, parseInt(options.limit) || 10);
  const skip = (page - 1) * limit;
  const sort = options.sort || { createdAt: -1 };
  const populate = options.populate || '';
  const select = options.select || '';

  const [data, total] = await Promise.all([
    model.find(query).sort(sort).skip(skip).limit(limit)
      .populate(populate)
      .select(select)
      .lean(),
    model.countDocuments(query),
  ]);

  return {
    data,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
  };
};

module.exports = { paginate };
