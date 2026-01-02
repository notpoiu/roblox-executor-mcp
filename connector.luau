--// Variables \\--
local BridgeURL = getgenv().BridgeURL or ... or "localhost:16384"

--// Functions \\--
local LuaEncode = loadstring(game:HttpGet("https://raw.githubusercontent.com/chadhyatt/LuaEncode/refs/heads/master/src/LuaEncode.lua"))()
local cloneref = cloneref or function(x) return x end
local decompile = decompile or function(x) return "-- Unable to get script content." end

--// Services \\--
local LogService = cloneref(game:GetService("LogService"))
local HttpService = cloneref(game:GetService("HttpService"))

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
                output = LuaEncode({
                    success = false,
                    error = message
                }, {
                    Prettify = true
                }),
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
            local response = request({
                Url = "http://" .. BridgeURL,
                Method = "GET"
            })
    
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
            while self.Connected do
                local success, err = pcall(function()
                    local response = request({
                        Url = "http://" .. BridgeURL .. "/poll",
                        Method = "GET"
                    })

                    --// Server might be down \\--
                    if response.StatusCode ~= 204 and response.StatusCode ~= 200 then
                        if not self:IsAlive() then
                            self.Connected = false
                        end

                        return
                    end
    
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
                    if not self:IsAlive() then
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

--// Main Loop \\--
while true do
    local Bridge = CreateBridge()

    Bridge:BindToType("execute", function(data)
        loadstring(data.source)()
        setthreadidentity(8)
    end)

    Bridge:BindToType("get-console-output", function(data)
        return LogService:GetLogHistory()
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

        return decompile(scriptInstance)
    end)

    Bridge:BindToType("search-instances", function(data)
        local rootInstance = loadstring("return " .. data.root)()
        local instances = rootInstance:QueryDescendants(data.selector)
        
        local limit = data.limit or 50
        local results = {}
        
        for i, instance in ipairs(instances) do
            if i > limit then break end
            table.insert(results, {
                Name = instance.Name,
                ClassName = instance.ClassName,
                FullPath = instance:GetFullName()
            })
        end
        
        return {
            count = #instances,
            limited = #instances > limit,
            results = results
        }
    end)

    Bridge:BindToType("get-game-info", function(data)
        local MarketplaceService = cloneref(game:GetService("MarketplaceService"))
        local RobloxReplicatedStorage = cloneref(game:GetService("RobloxReplicatedStorage"))
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
            IsVIPServer = RobloxReplicatedStorage.GetServerType:InvokeServer() == "VIPServer"
        }
    end)

    Bridge:WaitForDisconnect()
end
