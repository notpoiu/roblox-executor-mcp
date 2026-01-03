--// Wait for game to load \\--
if not game:IsLoaded() then
    game.Loaded:Wait()
end

--// Variables \\--
local BridgeURL = getgenv().BridgeURL or ... or "localhost:16384"

--// Functions \\--
local LuaEncode = loadstring(game:HttpGet("https://raw.githubusercontent.com/chadhyatt/LuaEncode/refs/heads/master/src/LuaEncode.lua"))()
local cloneref = cloneref or function(x) return x end
local decompile = decompile or function(x) return "-- Unable to get script content." end
local getnilinstances = getnilinstances or function() return {} end
local getscriptbytecode = getscriptbytecode or function(x) error("Unable to get script bytecode.") end

--// Services \\--
local RobloxReplicatedStorage = cloneref(game:GetService("RobloxReplicatedStorage"))
local MarketplaceService = cloneref(game:GetService("MarketplaceService"))
local CoreGui = cloneref(game:GetService("CoreGui"))
local CorePackages = cloneref(game:GetService("CorePackages"))
local HttpService = cloneref(game:GetService("HttpService"))
local LogService = cloneref(game:GetService("LogService"))

--// Compatibility Check \\--
local WebSocketAvailable = (
    typeof(WebSocket) ~= "nil" and
    typeof(WebSocket.connect) == "function"
) and (getgenv().DisableWebSocket ~= true)

--// Base Bridge Class \\--
local BaseBridge = {}; do
    BaseBridge.__index = BaseBridge
    
    function BaseBridge:BindToType(type, callback)
        self.Callbacks[type] = callback
    end
    
    function BaseBridge:HandleMessage(data)
        if self.Callbacks[data.type] then
            local success, result = pcall(function()
                return self.Callbacks[data.type](data)
            end)
    
            if success and result == nil then
                return nil
            end
    
            return self:FormatResponse(result, data.id, not success)
        end
        return nil
    end
    
    function BaseBridge:FormatResponse(message, id, isError)
        if isError then
            return {
                error = tostring(message),
                success = false,
                id = id
            }
        end
        
        local output = message
        if typeof(output) ~= "table" then
            output = { output }
        end
    
        return {
            output = LuaEncode(output, {
                Prettify = true
            }),
            success = true,
            id = id
        }
    end
    
    function BaseBridge:IsAlive()
        local success, result = pcall(function()
            local response
            local thread = task.spawn(function()
                local success, data = pcall(request, {
                    Url = "http://" .. BridgeURL,
                    Method = "GET"
                })

                if success then
                    response = data
                end
            end)

            local start = os.clock()
            repeat task.wait() until response ~= nil or os.clock() - start > 5

            if response == nil then
                task.cancel(thread)
                return false
            end
    
            -- 426 = Upgrade Required (WebSocket), 200 = HTTP mode
            if response.StatusCode == 426 or response.StatusCode == 200 then
                return true
            end
    
            return false
        end)
    
        if not success then
            return false
        end
    
        return result
    end
end

--// WebSocket Bridge \\--
local WebSocketBridge = setmetatable({}, {__index = BaseBridge}); do
    WebSocketBridge.__index = WebSocketBridge
    
    function WebSocketBridge.new()
        local self = setmetatable({}, WebSocketBridge)
    
        --// Yield until the server is alive \\--
        while not self:IsAlive() do
            task.wait(0.1)
        end
    
        --// Connect to the server \\--
        self.WebSocket = WebSocket.connect("ws://" .. BridgeURL)
        self.Connected = true
        self.Callbacks = {}
        self.AliveThread = task.spawn(function()
            while task.wait(1) do
                if self:IsAlive() or not self.Connected then
                    continue
                end
                
                self.Connected = false
                break
            end
    
            pcall(function()
                self.WebSocket:Close()
            end)
        end)
    
        --// On Message \\--
        self.WebSocket.OnMessage:Connect(function(message)
            local data = HttpService:JSONDecode(message)
            local response = self:HandleMessage(data)
            if response then
                self.WebSocket:Send(HttpService:JSONEncode(response))
            end
        end)
    
        --// On Close \\--
        self.WebSocket.OnClose:Connect(function()
            self.Connected = false
        end)
    
        return self
    end
    
    function WebSocketBridge:WaitForDisconnect()
        while self.Connected do
            task.wait(0.1)
        end
    end
end

--// HTTP Polling Bridge \\--
local HTTPBridge = setmetatable({}, {__index = BaseBridge}); do
    HTTPBridge.__index = HTTPBridge
    
    function HTTPBridge.new()
        local self = setmetatable({}, HTTPBridge)
    
        --// Yield until the server is alive \\--
        while not self:IsAlive() do
            task.wait(0.1)
        end
    
        self.Connected = true
        self.Callbacks = {}
        self.PollInterval = 0.1
    
        --// Start polling thread \\--
        self.PollThread = task.spawn(function()
            local consecutiveFailures = 0
            
            while self.Connected do
                local success, _ = pcall(function()
                    local response = request({
                        Url = "http://" .. BridgeURL .. "/poll",
                        Method = "GET"
                    })

                    --// Server might be down \\--
                    if response.StatusCode ~= 204 and response.StatusCode ~= 200 then
                        consecutiveFailures += 1
                        if consecutiveFailures >= 3 then
                            self.Connected = false
                        end

                        return
                    end
                    
                    consecutiveFailures = 0
    
                    --// Handle response \\--
                    if response.Body and response.Body ~= "" then
                        local data = HttpService:JSONDecode(response.Body)
                        if data == nil or data.type == nil then return end
                        
                        local result = self:HandleMessage(data)
                        if result == nil then return end
                        
                        --// Send response back \\--
                        request({
                            Url = "http://" .. BridgeURL .. "/respond",
                            Method = "POST",
                            Headers = {
                                ["Content-Type"] = "application/json"
                            },
                            Body = HttpService:JSONEncode(result)
                        })
                    end
                end)
    
                if not success then
                    consecutiveFailures += 1
                    if consecutiveFailures >= 3 then
                        self.Connected = false
                    end
                end
    
                task.wait(self.PollInterval)
            end
        end)
    
        return self
    end
    
    function HTTPBridge:WaitForDisconnect()
        while self.Connected do
            task.wait(0.1)
        end
    end
end

--// Create Bridge \\--
local function CreateBridge()
    if WebSocketAvailable then
        local success, bridge = pcall(function()
            return WebSocketBridge.new()
        end)
        
        if success then
            return bridge
        end
    end

    return HTTPBridge.new()
end

--// Script Source Mapping \\--
local ScriptSourcesMap = {
    HasFinishedMapping = false
}

local ScriptInstanceMap = setmetatable({}, { __mode = "v" })
local SourcesToMap, MappedSources = 0, 0

local function MapScriptSource(script)
    local debugId = script:GetDebugId()
    if ScriptSourcesMap[debugId] then return end

    for attempt = 1, 10 do
        local success, decompOutput = pcall(decompile, script)
        if not success then
            task.wait(0.5)
            continue
        end
    
        ScriptSourcesMap[debugId] = decompOutput
        MappedSources += 1
        break
    end

    ScriptInstanceMap[debugId] = script
    script.Destroying:Once(function()
        ScriptInstanceMap[debugId] = nil
    end)
end

local function GetScriptByDebugId(debugId)
    local CachedInstance = ScriptInstanceMap[debugId]
    if CachedInstance then
        return CachedInstance
    end

    for _, script in game:QueryDescendants("LuaSourceContainer") do
        if script:IsA("Script") and script.RunContext == Enum.RunContext.Server then continue end
        if script:GetDebugId() ~= debugId then continue end
        
        ScriptInstanceMap[debugId] = script
        return script
    end

    for _, script in getnilinstances() do
        if script:IsA("LuaSourceContainer") and not script:IsA("Script") and script.RunContext == Enum.RunContext.Client then
            if script:GetDebugId() ~= debugId then continue end
            
            ScriptInstanceMap[debugId] = script
            return script
        end
    end

    return nil
end

do
    local function ShouldMapScript(script)        
        local IsServerScript = script:IsA("Script") and script.RunContext == Enum.RunContext.Server
        if IsServerScript then return false end

        local IsRobloxScript = script.RobloxLocked or script:IsDescendantOf(CoreGui) or script:IsDescendantOf(CorePackages)
        if IsRobloxScript then return false end

        local IsAlreadyMapped = ScriptSourcesMap[script:GetDebugId()]
        if IsAlreadyMapped then return false end

        local HasBytecode = pcall(getscriptbytecode, script)
        if not HasBytecode then return false end

        return true
    end

    game.DescendantAdded:Connect(function(script)
        if not script:IsA("LuaSourceContainer") then
            return
        end

        if not ShouldMapScript(script) then return end
        MapScriptSource(script)
    end)

    local CategoriesToMap = {
        game:QueryDescendants("LuaSourceContainer"),
        getnilinstances()
    }

    --// Map script sources \\--
    task.spawn(function()
        local ValidScripts = {}
        for _, category in CategoriesToMap do
            for _, script in category do
                if not script:IsA("LuaSourceContainer") then continue end
                if not ShouldMapScript(script) then continue end

                table.insert(ValidScripts, script)
            end
        end

        SourcesToMap = #ValidScripts

        for idx, scriptObject in ValidScripts do
            task.defer(MapScriptSource, scriptObject)
            if idx % 250 == 0 then task.wait(0.1) end
        end

        ScriptSourcesMap.HasFinishedMapping = true
    end)
end

--// Parse Query \\--
local function ConvertEscapes(str)
    local ConvertedStr = str:gsub("\\n", "\n"):gsub("\\r", "\r"):gsub("\\t", "\t")
    return ConvertedStr
end

local function GetLineInfo(source)
    local lineStarts = {1}
    local i = 1
    while true do
        local found = source:find("\n", i, true)
        if not found then break end
        table.insert(lineStarts, found + 1)
        i = found + 1
    end
    return lineStarts
end

local function GetLineNumber(lineStarts, pos)
    local low, high = 1, #lineStarts
    local res = 1
    while low <= high do
        local mid = math.floor((low + high) / 2)
        if lineStarts[mid] <= pos then
            res = mid
            low = mid + 1
        else
            high = mid - 1
        end
    end
    return res
end

local function ParseQuery(query)
    local stringMatchQueries = {}
    do  
        local queries = {}
        local isEscaping = false
        local currentQuery = ""
        
        for idx, query in query:split("|") do
            local lastChar = string.sub(query, #query)

            --// Handle escaping \\--
            if lastChar == "\\" then
                local escapedQuery = string.sub(query, 1, #query - 1)
                if isEscaping then
                    currentQuery ..= escapedQuery .. "|"
                else
                    isEscaping = true
                    currentQuery = escapedQuery .. "|"
                end
                continue
            elseif isEscaping then
                isEscaping = false
                currentQuery ..= query
            else
                currentQuery = query
            end

            --// Check for AND queries (split by &) \\--
            if currentQuery:find("&") then
                local andParts = currentQuery:split("&")
                local andQueries = {}
                
                for _, part in andParts do
                    if part ~= "" then
                        table.insert(andQueries, part)
                    end
                end
                
                if #andQueries > 1 then
                    table.insert(queries, { AndQueries = andQueries })
                elseif #andQueries == 1 then
                    table.insert(queries, andQueries[1])
                end
            else
                table.insert(queries, currentQuery)
            end
        end

        for _, query in queries do
            if typeof(query) == "string" then
                if query == "" then continue end
                table.insert(stringMatchQueries, ConvertEscapes(query))
            elseif typeof(query) == "table" and query.AndQueries then
                local convertedAnd = {}
                for _, andQuery in query.AndQueries do
                    table.insert(convertedAnd, ConvertEscapes(andQuery))
                end
                table.insert(stringMatchQueries, { AndQueries = convertedAnd })
            end
        end
    end

    return stringMatchQueries
end

--// Main Loop \\--
while true do
    local Bridge = CreateBridge()

    Bridge:BindToType("execute", function(data)
        loadstring(data.source)()
        setthreadidentity(8)
    end)

    Bridge:BindToType("get-console-output", function(data)
        local limit = data.limit or 50
        local logsOrder = data.logsOrder or "NewestFirst"

        local logs = LogService:GetLogHistory()
        local results = {}
        
        if logsOrder == "NewestFirst" then
            for i = #logs, 1, -1 do
                if #results >= limit then break end
                table.insert(results, logs[i])
            end
        else
            for _, log in logs do
                if #results >= limit then break end
                table.insert(results, log)
            end
        end

        return { count = #LogService:GetLogHistory(), limited = #LogService:GetLogHistory() > limit, results = results }
    end)

    Bridge:BindToType("get-data-by-code", function(data)
        local dataOutput = table.pack(loadstring(data.source)())
        setthreadidentity(8)

        return dataOutput
    end)

    Bridge:BindToType("get-script-content", function(data)
        local scriptInstance = loadstring(data.source)()
        setthreadidentity(8)

        assert(typeof(scriptInstance) == "Instance", "Script instance is not an instance.")
        assert(scriptInstance:IsA("LuaSourceContainer"), "Script instance is not a LuaSourceContainer (Script, LocalScript, or ModuleScript).")
        assert(not (scriptInstance:IsA("Script") and scriptInstance.RunContext == Enum.RunContext.Server), "Script instance is a Server Script.")

        if not ScriptSourcesMap[scriptInstance:GetDebugId()] then
            MapScriptSource(scriptInstance)
        end

        return ScriptSourcesMap[scriptInstance:GetDebugId()]
    end)

    Bridge:BindToType("search-instances", function(data)
        local rootInstance = loadstring("return " .. data.root)()
        local instances = rootInstance:QueryDescendants(data.selector)
        
        local limit = data.limit or 50
        local results = {}
        
        for i, instance in instances do
            if i > limit then break end

            table.insert(results, {
                Name = instance.Name,
                ClassName = instance.ClassName,
                InstancePath = instance,
                DebugId = instance:GetDebugId()
            })
        end
        
        return {
            count = #instances,
            limited = #instances > limit,
            results = results
        }
    end)

    Bridge:BindToType("get-game-info", function(data)
        local productInfo = MarketplaceService:GetProductInfo(game.PlaceId)
        
        return {
            PlaceId = game.PlaceId,
            GameId = game.GameId,
            PlaceVersion = game.PlaceVersion,
            PlaceName = productInfo.Name,
            PlaceDescription = productInfo.Description,
            Creator = productInfo.Creator.Name,
            CreatorType = tostring(productInfo.Creator.CreatorType),
            CreatorId = productInfo.Creator.CreatorTargetId,
            JobId = game.JobId,
            ServerType = RobloxReplicatedStorage.GetServerType:InvokeServer()
        }
    end)

    Bridge:BindToType("search-scripts-sources", function(data)
        assert(ScriptSourcesMap.HasFinishedMapping, "The bridge is still mapping all script sources (" .. tostring(MappedSources) .. "/" .. tostring(SourcesToMap) .. ") please try again later.")

        local stringMatchQueries = ParseQuery(data.query)
        local limit = data.limit or 50
        local contextLines = data.contextLines or 2
        local totalMatches = 0
        local maxMatchesPerScript = data.maxMatchesPerScript or 20

        --// Pre-compute query info \\--
        local queryInfo = {}
        for idx, query in stringMatchQueries do
            local isLogicalAND = typeof(query) == "table"
            local isMultiLine = false
            
            if isLogicalAND then
                for _, q in query.AndQueries do
                    if not q:find("\n", 1, true) then continue end
                    
                    isMultiLine = true
                    break
                end
            else
                isMultiLine = query:find("\n", 1, true) ~= nil
            end
            
            queryInfo[idx] = { isLogicalAND = isLogicalAND, isMultiLine = isMultiLine }
        end

        --// Filter scripts that we need to process (search) \\--
        local matchingScripts = {}
        local count = 0
        
        for debugId, source in ScriptSourcesMap do
            if debugId == "HasFinishedMapping" then continue end
            if #matchingScripts >= limit then break end

            --// Rate limit \\--
            count += 1
            if count % 200 == 0 then task.wait() end

            --// Pre-check \\--
            local hasAnyPotentialMatch = false
            for idx, query in stringMatchQueries do
                local info = queryInfo[idx]
                
                if info.isLogicalAND then
                    local allPartsMatch = true
                    for _, andQuery in query.AndQueries do
                        if not source:find(andQuery, 1, true) then
                            allPartsMatch = false
                            break
                        end
                    end
                    if allPartsMatch then
                        hasAnyPotentialMatch = true
                        break
                    end
                elseif source:find(query, 1, true) then
                    hasAnyPotentialMatch = true
                    break
                end
            end

            if not hasAnyPotentialMatch then continue end
            
            table.insert(matchingScripts, { debugId = debugId, source = source })
        end

        --// Process matching scripts \\--
        local results = {}
        
        for _, scriptData in matchingScripts do
            if #results >= limit then break end
            
            local debugId = scriptData.debugId
            local source = scriptData.source
            
            --// Build line info lazily \\--
            local lines = nil
            local lineStarts = nil
            
            local function EnsureLineInfo()
                if lines then return end
                lines = {}
                local pos = 1
                local len = #source
                while pos <= len do
                    local newlinePos = source:find("\n", pos, true)
                    if newlinePos then
                        table.insert(lines, source:sub(pos, newlinePos - 1))
                        pos = newlinePos + 1
                    else
                        table.insert(lines, source:sub(pos))
                        break
                    end
                end
                lineStarts = GetLineInfo(source)
            end

            local function AddMatch(matchingLines, startLine, endLine, matchedContent)
                EnsureLineInfo()
                
                local before = {}
                for i = math.max(1, startLine - contextLines), startLine - 1 do
                    table.insert(before, { lineNumber = i, content = lines[i] or "" })
                end
                
                local after = {}
                for i = endLine + 1, math.min(#lines, endLine + contextLines) do
                    table.insert(after, { lineNumber = i, content = lines[i] or "" })
                end
                
                local content
                if startLine == endLine then
                    content = matchedContent or lines[startLine] or ""
                else
                    content = {}
                    for i = startLine, endLine do
                        table.insert(content, { lineNumber = i, content = lines[i] or "" })
                    end
                end
                
                table.insert(matchingLines, {
                    lineNumber = startLine,
                    endLineNumber = endLine,
                    content = content,
                    before = before,
                    after = after
                })
            end

            --// Find all matching lines \\--
            local matchingLines = {}
            local matchedPositions = {}
            
            for idx, query in stringMatchQueries do
                if #matchingLines >= maxMatchesPerScript then break end
                
                local info = queryInfo[idx]
                
                if info.isMultiLine then
                    EnsureLineInfo()

                    local searchStart = 1
                    while #matchingLines < maxMatchesPerScript do
                        local matchStart, matchEnd
                        
                        if info.isLogicalAND then
                            local allMatch = true
                            local minStart, maxEnd = math.huge, 0
                            for _, andQuery in query.AndQueries do
                                local s, e = source:find(andQuery, searchStart, true)
                                if not s then
                                    allMatch = false
                                    break
                                end

                                minStart = math.min(minStart, s)
                                maxEnd = math.max(maxEnd, e)
                            end

                            if allMatch then matchStart, matchEnd = minStart, maxEnd end
                        else
                            matchStart, matchEnd = source:find(query, searchStart, true)
                        end
                        
                        if not matchStart then break end
                        
                        local posKey = matchStart
                        if not matchedPositions[posKey] then
                            matchedPositions[posKey] = true
                            local startLine = GetLineNumber(lineStarts, matchStart)
                            local endLine = GetLineNumber(lineStarts, matchEnd)
                            local matchedContent = source:sub(matchStart, matchEnd)
                            AddMatch(matchingLines, startLine, endLine, matchedContent)
                        end

                        searchStart = matchEnd + 1
                    end

                else
                    
                    local searchStart = 1
                    while #matchingLines < maxMatchesPerScript do
                        local matchStart, matchEnd
                        
                        if info.isLogicalAND then
                            -- For AND queries, find first query then verify others on same line
                            local firstQuery = query.AndQueries[1]
                            matchStart, matchEnd = source:find(firstQuery, searchStart, true)
                            
                            if matchStart then
                                -- Find line boundaries
                                local lineStart = source:sub(1, matchStart):match(".*\n()") or 1
                                local lineEnd = source:find("\n", matchEnd, true) or (#source + 1)
                                local lineContent = source:sub(lineStart, lineEnd - 1)
                                
                                -- Check all AND queries match on this line
                                local allMatch = true
                                for i = 2, #query.AndQueries do
                                    if not lineContent:find(query.AndQueries[i], 1, true) then
                                        allMatch = false
                                        break
                                    end
                                end
                                
                                if not allMatch then
                                    searchStart = lineEnd + 1
                                    continue
                                end
                                
                                matchStart = lineStart
                                matchEnd = lineEnd - 1
                            end
                        else
                            matchStart, matchEnd = source:find(query, searchStart, true)
                        end
                        
                        if not matchStart then break end
                        
                        EnsureLineInfo()
                        local lineNumber = GetLineNumber(lineStarts, matchStart)
                        
                        if not matchedPositions[lineNumber] then
                            matchedPositions[lineNumber] = true
                            AddMatch(matchingLines, lineNumber, lineNumber, lines[lineNumber])
                        end
                        
                        local nextNewline = source:find("\n", matchEnd, true)
                        if not nextNewline then break end
                        searchStart = nextNewline + 1
                    end
                end
            end

            if #matchingLines == 0 then continue end

            local scriptRef = GetScriptByDebugId(debugId)
            local scriptPath = scriptRef and scriptRef or "<ScriptProxy: " .. debugId .. ">"

            totalMatches += #matchingLines
            table.insert(results, {
                Script = scriptPath,
                MatchCount = #matchingLines,
                Matches = matchingLines
            })
        end

        return {
            count = #results,
            totalMatches = totalMatches,
            limited = #results >= limit,
            results = results
        }
    end)

    Bridge:WaitForDisconnect()
end

